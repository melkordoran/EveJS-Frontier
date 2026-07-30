/**
 * EVE Service Manager
 *
 * Ported from EVEServiceManager in eve-server.cpp.
 * Registers game services by name and dispatches CALL_REQ to them.
 */

const path = require("path");
const log = require(path.join(__dirname, "../utils/logger"));

class ServiceManager {
  constructor() {
    this._services = new Map();
    this._boundObjects = new Map(); // OID string -> service instance
    this._boundObjectParams = new Map(); // OID string -> bind parameter (e.g. corporationID)
  }

  /**
   * Register a service instance. The service must have a `name` property.
   * @param {BaseService} service
   */
  register(service) {
    const name = service.name;
    if (!name) {
      throw new Error("service must have a 'name' property!");
    }
    if (this._services.has(name)) {
      log.warn(`service already registered: ${name}`);
    }
    service.serviceManager = this;
    this._services.set(name, service);
    log.debug(`service registered: ${name}`);
  }

  /**
   * Register an alias for an already-registered service instance.
   * @param {string} alias
   * @param {string|BaseService} target
   */
  registerAlias(alias, target) {
    const normalizedAlias = String(alias || "").trim();
    if (!normalizedAlias) {
      throw new Error("alias must be a non-empty string");
    }
    const service =
      typeof target === "string"
        ? this.lookup(target)
        : target;
    if (!service) {
      throw new Error(`cannot register alias ${normalizedAlias}; target service not found`);
    }
    if (this._services.has(normalizedAlias)) {
      log.warn(`service alias already registered: ${normalizedAlias}`);
    }
    this._services.set(normalizedAlias, service);
    log.debug(`service alias registered: ${normalizedAlias} -> ${service.name}`);
  }

  /**
   * Register a bound object OID string -> service mapping.
   * Called whenever a service creates a bound object via MachoBindObject.
   */
  registerBoundObject(oidString, service) {
    this._boundObjects.set(oidString, service);
    log.debug(`bound object registered: ${oidString} -> ${service.name}`);
  }

  /**
   * Record the bind parameter a bound object was created with (e.g. the
   * corporationID a corpRegistry object is bound to). This lets bound-object
   * method handlers operate on the entity that was bound rather than falling
   * back to the caller's own session entity.
   */
  registerBoundObjectParams(oidString, params) {
    if (typeof oidString !== "string" || oidString === "") {
      return;
    }
    this._boundObjectParams.set(oidString, params);
  }

  /**
   * Release a bound object after the client sends
   * ObjectCallGPCS.ClientHasReleasedTheseObjects with matching OID- metadata.
   *
   * TQ removes both the dispatch registration and the bind parameters.  A
   * service may expose onBoundObjectReleased for additional cleanup; the
   * common _boundContexts Map is cleaned as a compatibility fallback.
   */
  unregisterBoundObject(oidString, options = {}) {
    if (typeof oidString !== "string" || oidString === "") {
      return false;
    }

    const service = this._boundObjects.get(oidString) || null;
    const preserveReusableSessionIdentity = Boolean(
      service && service.reuseBoundObjectForSession === true,
    );
    const existed = this._boundObjects.delete(oidString);
    this._boundObjectParams.delete(oidString);

    if (service && typeof service.onBoundObjectReleased === "function") {
      service.onBoundObjectReleased(oidString, options);
    } else if (service && service._boundContexts instanceof Map) {
      service._boundContexts.delete(oidString);
    }

    const session = options && options.session;
    if (session && session._boundObjectIDs && typeof session._boundObjectIDs === "object") {
      for (const [serviceName, objectID] of Object.entries(session._boundObjectIDs)) {
        if (objectID === oidString && !preserveReusableSessionIdentity) {
          delete session._boundObjectIDs[serviceName];
        }
      }
    }
    if (session && session._boundObjectState && typeof session._boundObjectState === "object") {
      for (const [serviceName, state] of Object.entries(session._boundObjectState)) {
        if (state && state.objectID === oidString) {
          delete session._boundObjectState[serviceName];
        }
      }
    }
    if (session && session.currentBoundObjectID === oidString) {
      session.currentBoundObjectID = null;
    }
    if (session && session.lastBoundObjectID === oidString) {
      session.lastBoundObjectID = null;
    }

    if (existed) {
      log.debug(`bound object released: ${oidString}`);
    }
    return existed;
  }

  /**
   * Look up the bind parameter recorded for a bound object OID.
   * Returns null when the OID is unknown or has no recorded parameter.
   */
  getBoundObjectParams(oidString) {
    if (typeof oidString !== "string" || oidString === "") {
      return null;
    }
    return this._boundObjectParams.has(oidString)
      ? this._boundObjectParams.get(oidString)
      : null;
  }

  /**
   * Look up a registered service by name, also checking bound object OIDs.
   * @param {string} name
   * @returns {BaseService|null}
   */
  lookup(name) {
    return this._services.get(name) || this._boundObjects.get(name) || null;
  }

  /**
   * Get a list of all registered service names.
   */
  getServiceNames() {
    return Array.from(this._services.keys());
  }

  /**
   * Get the total number of registered services.
   */
  get count() {
    return this._services.size;
  }
}

module.exports = ServiceManager;

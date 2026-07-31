#!/usr/bin/env python3

import argparse
import importlib
import json
import math
import os
import pickle
import sqlite3
import sys
import types


BOOLEAN_FIELDS = {
    "anchorable",
    "anchored",
    "deleted",
    "disallowAutoRepeat",
    "displayWhenZero",
    "electronicChance",
    "fittableNonSingleton",
    "hasPlayerPersonnelManager",
    "highIsGood",
    "isAssistance",
    "isConquerable",
    "isDynamicType",
    "isOffensive",
    "isWarpSafe",
    "propulsionChance",
    "published",
    "rangeChance",
    "sendCharTerminationMessage",
    "stackable",
    "uniqueName",
    "useBasePrice",
    "useOperationName",
}

NATIVE_TABLES = (
    ("agentTypes", "agentTypesLoader", "agentTypes.jsonl"),
    ("bloodlines", "bloodlinesLoader", "bloodlines.jsonl"),
    ("categories", "categoriesLoader", "categories.jsonl"),
    ("dogmaAttributes", "dogmaAttributesLoader", "dogmaAttributes.jsonl"),
    ("dogmaEffects", "dogmaEffectsLoader", "dogmaEffects.jsonl"),
    ("factions", "factionsLoader", "factions.jsonl"),
    ("groups", "groupsLoader", "groups.jsonl"),
    ("npcCharacters", "npcCharactersLoader", "npcCharacters.jsonl"),
    ("npcCorporations", "npcCorporationsLoader", "npcCorporations.jsonl"),
    ("races", "racesLoader", "races.jsonl"),
    ("stationOperations", "stationOperationsLoader", "stationOperations.jsonl"),
    ("typeDogma", "typeDogmaLoader", "typeDogma.jsonl"),
    ("typeMaterials", "typeMaterialsLoader", "typeMaterials.jsonl"),
    ("types", "typesLoader", "types.jsonl"),
)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Decode EVE Frontier client static data into EveJS JSONL.",
    )
    parser.add_argument("--request", required=True)
    parser.add_argument("--out", required=True)
    return parser.parse_args()


def install_blue_stub():
    blue = types.ModuleType("blue")
    blue.LoadExtension = lambda name: importlib.import_module(name)
    sys.modules["blue"] = blue


def read_request(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def resource_path(request, key):
    return request["resources"][key]["physicalPath"]


def load_localization(path):
    with open(path, "rb") as handle:
        language, messages = pickle.load(handle)
    if not isinstance(messages, dict):
        raise TypeError("Unexpected Frontier localization payload")
    return language, messages


def localized_text(messages, message_id, fallback=""):
    if message_id in (None, 0):
        return fallback
    entry = messages.get(int(message_id))
    if isinstance(entry, tuple) and entry:
        return entry[0] or fallback
    if isinstance(entry, str):
        return entry
    return fallback


def localized_value(messages, message_id, fallback=""):
    text = localized_text(messages, message_id, fallback)
    return {"en": text} if text else {}


def clean_float(value):
    return value if math.isfinite(value) else None


def object_fields(value):
    result = {}
    for name in dir(value):
        if name.startswith("_"):
            continue
        try:
            field_value = getattr(value, name)
        except (AttributeError, KeyError):
            continue
        if callable(field_value):
            continue
        result[name] = to_plain(field_value)
    return result


def to_plain(value):
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        return clean_float(value)
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, (list, tuple)):
        return [to_plain(item) for item in value]
    if isinstance(value, dict):
        return {str(key): to_plain(item) for key, item in value.items()}
    if isinstance(value, set):
        return [to_plain(item) for item in sorted(value)]

    module_name = type(value).__module__
    type_name = type(value).__name__
    if type_name == "VectorLoader" and hasattr(value, "data"):
        return [clean_float(float(item)) for item in value.data]
    if hasattr(value, "items") and (
        module_name == "cfsd" or
        type_name.endswith("DictLoader") or
        type_name == "MultiIndexLoader"
    ):
        return {str(key): to_plain(item) for key, item in value.items()}
    if hasattr(value, "__iter__") and module_name == "cfsd":
        return [to_plain(item) for item in value]
    return object_fields(value)


def native_row(table_name, key, value, messages):
    row = object_fields(value)
    row["_key"] = key

    for field in BOOLEAN_FIELDS:
        if field in row:
            row[field] = bool(row[field])

    translations = {
        "agentTypes": (("agentType", "agentTypeNameID"),),
        "bloodlines": (("name", "nameID"), ("description", "descriptionID")),
        "categories": (("name", "categoryNameID"),),
        "dogmaAttributes": (
            ("displayName", "displayNameID"),
            ("tooltipDescription", "tooltipDescriptionID"),
            ("tooltipTitle", "tooltipTitleID"),
        ),
        "dogmaEffects": (
            ("displayName", "displayNameID"),
            ("description", "descriptionID"),
        ),
        "factions": (
            ("name", "nameID"),
            ("description", "descriptionID"),
            ("shortDescription", "shortDescriptionID"),
        ),
        "groups": (("name", "groupNameID"),),
        "npcCharacters": (("name", "nameID"),),
        "npcCorporations": (
            ("name", "nameID"),
            ("description", "descriptionID"),
        ),
        "races": (("name", "nameID"), ("description", "descriptionID")),
        "stationOperations": (
            ("operationName", "operationNameID"),
            ("description", "descriptionID"),
        ),
        "types": (("name", "typeNameID"), ("description", "descriptionID")),
    }
    for target, source in translations.get(table_name, ()):
        if source in row:
            fallback = row.get(target, "") if isinstance(row.get(target), str) else ""
            if table_name == "types" and target == "name" and not fallback:
                fallback = f"Type {key}"
            row[target] = localized_value(messages, row[source], fallback)

    if table_name == "dogmaAttributes" and "categoryID" in row:
        row["attributeCategoryID"] = row["categoryID"]

    return row


def sorted_keys(mapping):
    return sorted(mapping.keys(), key=lambda value: (not isinstance(value, int), value))


def write_jsonl(out_dir, file_name, rows):
    target = os.path.join(out_dir, file_name)
    temporary = f"{target}.tmp"
    count = 0
    with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(
                json.dumps(
                    row,
                    ensure_ascii=True,
                    allow_nan=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ),
            )
            handle.write("\n")
            count += 1
    os.replace(temporary, target)
    return count


def export_native_tables(request, out_dir, messages, report):
    for resource_key, module_name, file_name in NATIVE_TABLES:
        loader = importlib.import_module(module_name)
        table = loader.load(resource_path(request, resource_key))
        rows = (
            native_row(resource_key, key, table[key], messages)
            for key in sorted_keys(table)
        )
        report["outputs"][file_name] = write_jsonl(out_dir, file_name, rows)


def load_static(resource, schema=None):
    from fsd.schemas.binaryLoader import LoadFSDDataInPython
    return LoadFSDDataInPython(resource, schema)


def vector(value):
    if value is None:
        return {"x": 0.0, "y": 0.0, "z": 0.0}
    data = value.data if hasattr(value, "data") else value
    return {
        "x": clean_float(float(data[0])),
        "y": clean_float(float(data[1])),
        "z": clean_float(float(data[2])),
    }


def optional(value, field, default=None):
    try:
        return getattr(value, field)
    except (AttributeError, KeyError):
        return default


def static_row(key, value, name_field=None):
    row = object_fields(value)
    row["_key"] = key
    if "center" in row:
        row["position"] = vector(optional(value, "center"))
    if name_field and isinstance(row.get(name_field), str):
        row["name"] = {"en": row[name_field]}
    return row


def export_universe_tables(request, out_dir, report):
    systems = load_static(
        resource_path(request, "systems"),
        resource_path(request, "systemsSchema"),
    )
    regions = load_static(
        resource_path(request, "regions"),
        resource_path(request, "regionsSchema"),
    )
    constellations = load_static(
        resource_path(request, "constellations"),
        resource_path(request, "constellationsSchema"),
    )
    content = load_static(resource_path(request, "solarSystemContent"))
    location_cache = load_static(resource_path(request, "locationCache"))
    jumps = load_static(
        resource_path(request, "jumps"),
        resource_path(request, "jumpsSchema"),
    )

    report["outputs"]["mapRegions.jsonl"] = write_jsonl(
        out_dir,
        "mapRegions.jsonl",
        (static_row(key, regions[key], "name") for key in sorted_keys(regions)),
    )
    report["outputs"]["mapConstellations.jsonl"] = write_jsonl(
        out_dir,
        "mapConstellations.jsonl",
        (static_row(key, constellations[key], "name") for key in sorted_keys(constellations)),
    )

    def solar_system_rows():
        for key in sorted_keys(systems):
            system = systems[key]
            system_content = content.get(key, None)
            star = optional(system_content, "star")
            yield {
                "_key": key,
                "constellationID": int(system.constellationID),
                "name": {"en": str(system.name)},
                "nameID": int(system.nameID),
                "position": vector(system.center),
                "radius": float(optional(system_content, "radius", 0.0)),
                "regionID": int(system.regionID),
                "securityClass": str(optional(system, "securityClass", "")),
                "securityStatus": float(optional(system, "securityStatus", 0.0)),
                "starID": int(optional(star, "id", 0) or 0),
                "sunTypeID": int(optional(system, "sunTypeID", 0) or 0),
            }

    report["outputs"]["mapSolarSystems.jsonl"] = write_jsonl(
        out_dir,
        "mapSolarSystems.jsonl",
        solar_system_rows(),
    )

    def jump_rows():
        for jump in sorted(jumps, key=lambda row: int(row.jumpID)):
            row = object_fields(jump)
            row["_key"] = int(jump.jumpID)
            row["fromCoordinate"] = vector(jump.fromCoordinate)
            row["toCoordinate"] = vector(jump.toCoordinate)
            yield row

    report["outputs"]["mapJumps.jsonl"] = write_jsonl(
        out_dir,
        "mapJumps.jsonl",
        jump_rows(),
    )
    report["outputs"]["locationCache.jsonl"] = write_jsonl(
        out_dir,
        "locationCache.jsonl",
        (
            {"_key": key, "solarSystemID": int(location_cache[key])}
            for key in sorted_keys(location_cache)
        ),
    )

    gate_details = {}
    gate_systems = {}
    for system_id in sorted_keys(content):
        system_content = content[system_id]
        gates = optional(system_content, "stargates")
        if gates is None:
            continue
        for gate_id in sorted_keys(gates):
            gate = gates[gate_id]
            gate_details[int(gate_id)] = {
                "destinationID": int(gate.destination),
                "planetID": int(optional(gate, "planetID", 0) or 0),
                "position": vector(gate.position),
                "solarSystemID": int(system_id),
                "typeID": int(gate.typeID),
            }
            gate_systems[int(gate_id)] = int(system_id)

    database_path = request["mapObjectsDb"]["physicalPath"]
    connection = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        celestial_rows = connection.execute(
            "SELECT celestialID, celestialNameID, solarSystemID, typeID, groupID, "
            "radius, x, y, z, orbitID, orbitIndex, celestialIndex "
            "FROM celestials ORDER BY celestialID",
        )
        by_group = {6: [], 7: [], 8: [], 10: [], 4870: []}
        for raw in celestial_rows:
            row = {
                "_key": int(raw["celestialID"]),
                "celestialIndex": raw["celestialIndex"],
                "celestialNameID": raw["celestialNameID"],
                "groupID": int(raw["groupID"]),
                "orbitID": raw["orbitID"],
                "orbitIndex": raw["orbitIndex"],
                "position": {
                    "x": clean_float(float(raw["x"])),
                    "y": clean_float(float(raw["y"])),
                    "z": clean_float(float(raw["z"])),
                },
                "radius": int(raw["radius"]) if raw["radius"] is not None else None,
                "solarSystemID": int(raw["solarSystemID"]),
                "typeID": int(raw["typeID"]),
            }
            by_group.setdefault(row["groupID"], []).append(row)

        stars = by_group.pop(6)
        planets = by_group.pop(7)
        moons = by_group.pop(8)
        stargates = by_group.pop(10)
        lagrange_points = by_group.pop(4870)
        if any(by_group.values()):
            unknown = {key: len(value) for key, value in by_group.items() if value}
            raise ValueError(f"Unhandled mapObjects celestial groups: {unknown}")

        for row in stargates:
            detail = gate_details.get(row["_key"])
            if detail is None:
                raise KeyError(f"Stargate {row['_key']} is absent from solarSystemContent.static")
            destination_id = detail["destinationID"]
            row["destination"] = {
                "solarSystemID": gate_systems.get(destination_id, 0),
                "stargateID": destination_id,
            }
            row["planetID"] = detail["planetID"]
            row["position"] = detail["position"]

        report["outputs"]["mapStars.jsonl"] = write_jsonl(
            out_dir, "mapStars.jsonl", iter(stars),
        )
        report["outputs"]["mapPlanets.jsonl"] = write_jsonl(
            out_dir, "mapPlanets.jsonl", iter(planets),
        )
        report["outputs"]["mapMoons.jsonl"] = write_jsonl(
            out_dir, "mapMoons.jsonl", iter(moons),
        )
        report["outputs"]["mapStargates.jsonl"] = write_jsonl(
            out_dir, "mapStargates.jsonl", iter(stargates),
        )
        report["outputs"]["mapLagrangePoints.jsonl"] = write_jsonl(
            out_dir, "mapLagrangePoints.jsonl", iter(lagrange_points),
        )

        station_rows = connection.execute(
            "SELECT stationID, orbitID, solarSystemID, ownerID, typeID, x, y, z, "
            "operationID, reprocessingEfficiency, reprocessingStationsTake, "
            "reprocessingHangarFlag, isConquerable, useOperationName, orbitIndex, "
            "celestialIndex FROM npcStations ORDER BY stationID",
        )

        def stations():
            for raw in station_rows:
                yield {
                    "_key": int(raw["stationID"]),
                    "celestialIndex": raw["celestialIndex"],
                    "isConquerable": bool(raw["isConquerable"]),
                    "operationID": int(raw["operationID"]),
                    "orbitID": int(raw["orbitID"]),
                    "orbitIndex": raw["orbitIndex"],
                    "ownerID": int(raw["ownerID"]),
                    "position": {
                        "x": clean_float(float(raw["x"])),
                        "y": clean_float(float(raw["y"])),
                        "z": clean_float(float(raw["z"])),
                    },
                    "reprocessingEfficiency": float(raw["reprocessingEfficiency"]),
                    "reprocessingHangarFlag": int(raw["reprocessingHangarFlag"]),
                    "reprocessingStationsTake": float(raw["reprocessingStationsTake"]),
                    "solarSystemID": int(raw["solarSystemID"]),
                    "typeID": int(raw["typeID"]),
                    "useOperationName": bool(raw["useOperationName"]),
                }

        report["outputs"]["npcStations.jsonl"] = write_jsonl(
            out_dir, "npcStations.jsonl", stations(),
        )
    finally:
        connection.close()


def main():
    args = parse_args()
    request = read_request(args.request)
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)

    install_blue_stub()
    language, messages = load_localization(resource_path(request, "localization"))
    report = {
        "build": request["client"]["build"],
        "localizationLanguage": language,
        "localizationMessages": len(messages),
        "outputs": {},
    }

    sde_meta = {
        "_key": "sde",
        "buildNumber": request["client"]["build"],
        "branch": request["client"]["branch"],
        "codename": request["client"]["codename"],
        "provider": "EVE Frontier installed client cache",
        "releaseDate": None,
        "version": request["client"]["version"],
    }
    report["outputs"]["_sde.jsonl"] = write_jsonl(
        out_dir, "_sde.jsonl", iter((sde_meta,)),
    )

    export_native_tables(request, out_dir, messages, report)
    export_universe_tables(request, out_dir, report)
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()

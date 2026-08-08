#!/usr/bin/env python3

import argparse
import json
import marshal
import os
import types
import zipfile

from google.protobuf import descriptor_pb2
from google.protobuf import json_format


def parse_args():
    parser = argparse.ArgumentParser(
        description="Export protobuf descriptors and module inventory from code.ccp.",
    )
    parser.add_argument("--request", required=True)
    parser.add_argument("--out", required=True)
    return parser.parse_args()


def read_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def walk_code_objects(code):
    yield code
    for constant in code.co_consts:
        if isinstance(constant, types.CodeType):
            yield from walk_code_objects(constant)


def descriptor_from_blob(blob):
    if not isinstance(blob, bytes) or len(blob) < 8:
        return None
    descriptor = descriptor_pb2.FileDescriptorProto()
    try:
        descriptor.ParseFromString(blob)
    except Exception:
        return None
    if not descriptor.name.endswith(".proto"):
        return None
    if not descriptor.package.startswith("eve_public"):
        return None
    return descriptor


def extract_descriptor(member_bytes):
    if len(member_bytes) < 16:
        return None
    try:
        code = marshal.loads(member_bytes[16:])
    except Exception:
        return None
    for code_object in walk_code_objects(code):
        for constant in code_object.co_consts:
            descriptor = descriptor_from_blob(constant)
            if descriptor is not None:
                return descriptor
    return None


def field_summary(field):
    result = {
        "name": field.name,
        "number": field.number,
        "label": descriptor_pb2.FieldDescriptorProto.Label.Name(field.label),
        "type": descriptor_pb2.FieldDescriptorProto.Type.Name(field.type),
    }
    if field.type_name:
        result["typeName"] = field.type_name
    if field.HasField("oneof_index"):
        result["oneofIndex"] = field.oneof_index
    if field.options.deprecated:
        result["deprecated"] = True
    return result


def message_summary(message, package, parents=()):
    path_parts = (*parents, message.name)
    full_name = ".".join((package, *path_parts)) if package else ".".join(path_parts)
    result = {
        "name": message.name,
        "fullName": full_name,
        "fields": [field_summary(field) for field in message.field],
    }
    if message.oneof_decl:
        result["oneofs"] = [entry.name for entry in message.oneof_decl]
    if message.options.deprecated:
        result["deprecated"] = True
    nested = []
    for child in message.nested_type:
        nested.extend(message_summary(child, package, path_parts))
    return [result, *nested]


def enum_summary(enum, package, parents=()):
    path_parts = (*parents, enum.name)
    return {
        "name": enum.name,
        "fullName": ".".join((package, *path_parts)) if package else ".".join(path_parts),
        "values": [
            {"name": value.name, "number": value.number}
            for value in enum.value
        ],
    }


def descriptor_summary(descriptor, source_member):
    messages = []
    enums = []
    for message in descriptor.message_type:
        messages.extend(message_summary(message, descriptor.package))
        for enum in message.enum_type:
            enums.append(enum_summary(enum, descriptor.package, (message.name,)))
    enums.extend(
        enum_summary(enum, descriptor.package)
        for enum in descriptor.enum_type
    )
    return {
        "name": descriptor.name,
        "package": descriptor.package,
        "syntax": descriptor.syntax,
        "dependencies": list(descriptor.dependency),
        "messages": messages,
        "enums": enums,
        "services": [service.name for service in descriptor.service],
        "sourceMember": source_member,
    }


def write_json(path, value):
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")


def main():
    args = parse_args()
    request = read_json(args.request)
    code_path = request["codePath"]
    prefixes = tuple(request["clientModulePrefixes"])
    os.makedirs(args.out, exist_ok=True)

    descriptors = {}
    descriptor_sources = {}
    client_modules = []
    proto_members = []
    failures = []

    with zipfile.ZipFile(code_path, "r") as archive:
        for member_name in sorted(archive.namelist()):
            if member_name.endswith(".pyc") and member_name.startswith(prefixes):
                client_modules.append(member_name)
            if not (
                member_name.startswith("eveProto/generated/eve_public/")
                and member_name.endswith("_pb2.pyc")
            ):
                continue
            proto_members.append(member_name)
            try:
                descriptor = extract_descriptor(archive.read(member_name))
            except Exception as error:
                failures.append({"member": member_name, "error": str(error)})
                continue
            if descriptor is None:
                failures.append({
                    "member": member_name,
                    "error": "serialized FileDescriptorProto not found",
                })
                continue
            descriptors[descriptor.name] = descriptor
            descriptor_sources[descriptor.name] = member_name

    descriptor_set = descriptor_pb2.FileDescriptorSet()
    for name in sorted(descriptors):
        descriptor_set.file.add().CopyFrom(descriptors[name])

    binary_name = "frontier-public-protos.pb"
    json_name = "frontier-public-protos.json"
    modules_name = "frontier-client-modules.json"
    index_name = "frontier-contract-index.json"

    with open(os.path.join(args.out, binary_name), "wb") as handle:
        handle.write(descriptor_set.SerializeToString(deterministic=True))
    write_json(
        os.path.join(args.out, json_name),
        json_format.MessageToDict(
            descriptor_set,
            preserving_proto_field_name=True,
        ),
    )
    write_json(
        os.path.join(args.out, modules_name),
        {
            "build": request["build"],
            "prefixes": list(prefixes),
            "modules": client_modules,
        },
    )
    write_json(
        os.path.join(args.out, index_name),
        {
            "format": "evejs-frontier-contract-index-v1",
            "build": request["build"],
            "descriptorFiles": [
                descriptor_summary(descriptors[name], descriptor_sources[name])
                for name in sorted(descriptors)
            ],
            "failures": failures,
            "protoMembersScanned": proto_members,
        },
    )

    print(json.dumps({
        "outputs": [binary_name, json_name, modules_name, index_name],
        "summary": {
            "clientModules": len(client_modules),
            "descriptorFiles": len(descriptors),
            "failedDescriptors": len(failures),
            "protoMembers": len(proto_members),
        },
    }, sort_keys=True))


if __name__ == "__main__":
    main()

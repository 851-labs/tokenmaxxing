import { describe, expect, it } from "vitest";

import { fieldMessage, fieldNumber, fieldString, findField, readProtoFields } from "./protobuf";

function varint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = BigInt(value);
  while (remaining > 0x7fn) {
    bytes.push(Number(remaining & 0x7fn) | 0x80);
    remaining >>= 7n;
  }
  bytes.push(Number(remaining));

  return bytes;
}

function varintField(field: number, value: number): number[] {
  return [...varint((field << 3) | 0), ...varint(value)];
}

function bytesField(field: number, data: Uint8Array): number[] {
  return [...varint((field << 3) | 2), ...varint(data.length), ...data];
}

function stringField(field: number, value: string): number[] {
  return bytesField(field, new TextEncoder().encode(value));
}

describe("readProtoFields", () => {
  it("reads varint and length-delimited fields", () => {
    const buf = new Uint8Array([...varintField(1, 300), ...stringField(2, "hello")]);
    const fields = readProtoFields(buf);

    expect(fieldNumber(findField(fields, 1))).toBe(300);
    expect(fieldString(findField(fields, 2))).toBe("hello");
  });

  it("walks nested submessages", () => {
    const inner = bytesField(2, new Uint8Array(varintField(1, 42)));
    const buf = new Uint8Array(bytesField(1, new Uint8Array(inner)));

    const nested = fieldMessage(findField(readProtoFields(buf), 1));
    expect(fieldNumber(findField(fieldMessage(findField(nested, 2)), 1))).toBe(42);
  });

  it("decodes multi-byte varints", () => {
    const buf = new Uint8Array(varintField(9, 1_784_660_861));
    expect(fieldNumber(findField(readProtoFields(buf), 9))).toBe(1_784_660_861);
  });

  it("stops at truncated input instead of throwing", () => {
    const buf = new Uint8Array([...varintField(1, 1), ...varint((2 << 3) | 2), 100, 65]);
    const fields = readProtoFields(buf);

    expect(fields).toHaveLength(1);
    expect(fieldNumber(findField(fields, 1))).toBe(1);
  });

  it("rejects non-printable strings", () => {
    const buf = new Uint8Array(bytesField(3, new Uint8Array([0xff, 0xfe, 0x00])));
    expect(fieldString(findField(readProtoFields(buf), 3))).toBeUndefined();
  });

  it("returns undefined for missing fields", () => {
    const fields = readProtoFields(new Uint8Array(varintField(1, 7)));
    expect(findField(fields, 2)).toBeUndefined();
    expect(fieldNumber(undefined)).toBeUndefined();
    expect(fieldString(undefined)).toBeUndefined();
    expect(fieldMessage(undefined)).toEqual([]);
  });
});

/**
 * Minimal protobuf wire reader — just enough to walk length-delimited
 * submessages and varints (antigravity's gen_metadata blobs). Fixed32/64
 * fields are skipped; groups and other legacy wire types stop the parse
 * instead of desynchronizing the buffer.
 */

interface ProtoField {
  /** Present for wire type 2 (length-delimited). */
  bytes?: Uint8Array;
  /** Field number from the tag. */
  field: number;
  /** Present for wire type 0 (varint). */
  varint?: bigint;
  /** Wire type (0 = varint, 2 = length-delimited). */
  wire: number;
}

function readProtoFields(buf: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let pos = 0;

  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (tag === undefined) {
      break;
    }
    pos = tag.next;

    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (field === 0) {
      break;
    }

    if (wire === 0) {
      const value = readVarint(buf, pos);
      if (value === undefined) {
        break;
      }
      pos = value.next;
      fields.push({ field, varint: value.value, wire });
    } else if (wire === 2) {
      const length = readVarint(buf, pos);
      if (length === undefined) {
        break;
      }
      pos = length.next;
      const end = pos + Number(length.value);
      if (end > buf.length) {
        break;
      }
      fields.push({ bytes: buf.subarray(pos, end), field, wire });
      pos = end;
    } else if (wire === 5) {
      pos += 4;
    } else if (wire === 1) {
      pos += 8;
    } else {
      break;
    }
  }

  return fields;
}

function readVarint(buf: Uint8Array, pos: number): { next: number; value: bigint } | undefined {
  let value = 0n;
  let shift = 0n;
  while (pos < buf.length && shift < 70n) {
    const byte = buf[pos]!;
    pos += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { next: pos, value };
    }
    shift += 7n;
  }

  return undefined;
}

/** First field with the given number, if present. */
function findField(fields: readonly ProtoField[], field: number): ProtoField | undefined {
  return fields.find((entry) => entry.field === field);
}

/** Length-delimited field decoded as UTF-8, if printable. */
function fieldString(field: ProtoField | undefined): string | undefined {
  if (field?.bytes === undefined) {
    return undefined;
  }

  const text = new TextDecoder("utf-8", { fatal: false }).decode(field.bytes);
  return /^[\x20-\x7e]*$/.test(text) ? text : undefined;
}

/** Submessage fields of a length-delimited field. */
function fieldMessage(field: ProtoField | undefined): ProtoField[] {
  return field?.bytes === undefined ? [] : readProtoFields(field.bytes);
}

/** Varint field as a number, if it fits safely. */
function fieldNumber(field: ProtoField | undefined): number | undefined {
  if (field?.varint === undefined) {
    return undefined;
  }

  const value = field.varint;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

export { fieldMessage, fieldNumber, fieldString, findField, readProtoFields };

export type { ProtoField };

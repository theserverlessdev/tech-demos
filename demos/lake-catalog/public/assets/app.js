// ../../node_modules/.bun/@quack-protocol+sdk@0.3.0/node_modules/@quack-protocol/sdk/dist/messages-BsNzlNiY.js
var t = 9494;
var n = "/quack";
var r = "application/vnd.duckdb";
var i = 65535;
var a = 18446744073709551615n;
var s = 9223372036854775807n / 1000n;
var c = 2048;
var l = class extends Error {
  constructor(e, t) {
    super(e, t), this.name = "QuackError";
  }
};
var u = class extends l {
  constructor(e, t) {
    super(e, t), this.name = "QuackProtocolError";
  }
};
var ee = class extends l {
  serverMessage;
  exceptionType;
  extraInfo;
  mustInvalidate;
  constructor(e, t = {}) {
    super(t.exceptionType ? `${t.exceptionType} Error: ${e}` : e), this.name = "QuackServerError", this.serverMessage = e, this.exceptionType = t.exceptionType, this.extraInfo = t.extraInfo ?? {}, this.mustInvalidate = t.mustInvalidate ?? false;
  }
};
var d = class extends u {
  constructor(e, t) {
    super(e, t), this.name = "QuackUnsupportedTypeError";
  }
};
var te = new TextEncoder;
var ne = new TextDecoder;
var f = class {
  buffer;
  offset = 0;
  constructor(e = 1024) {
    this.buffer = new Uint8Array(e);
  }
  toUint8Array() {
    return this.buffer.slice(0, this.offset);
  }
  writeObject(e) {
    e(this), this.writeFieldId(i);
  }
  writeField(e, t) {
    this.writeFieldId(e), t(this);
  }
  writeFieldId(e) {
    if (!Number.isInteger(e) || e < 0 || e > 65535)
      throw new u(`Invalid field id ${e}`);
    this.ensure(2), this.buffer[this.offset++] = e & 255, this.buffer[this.offset++] = e >>> 8 & 255;
  }
  writeByte(e) {
    if (!Number.isInteger(e) || e < 0 || e > 255)
      throw new u(`Invalid byte ${e}`);
    this.ensure(1), this.buffer[this.offset++] = e;
  }
  writeBytes(e) {
    this.ensure(e.byteLength), this.buffer.set(e, this.offset), this.offset += e.byteLength;
  }
  writeBool(e) {
    this.writeByte(+!!e);
  }
  writeUleb(e) {
    let t = g(e);
    for (;t >= 128n; )
      this.writeByte(Number(t & 127n | 128n)), t >>= 7n;
    this.writeByte(Number(t));
  }
  writeSleb(e) {
    let t = BigInt(e), n = true;
    for (;n; ) {
      let e = Number(t & 127n);
      t >>= 7n;
      let r = (e & 64) != 0;
      t === 0n && !r || t === -1n && r ? n = false : e |= 128, this.writeByte(e);
    }
  }
  writeString(e) {
    this.writeStringBytes(te.encode(e));
  }
  writeStringBytes(e) {
    this.writeUleb(e.byteLength), this.writeBytes(e);
  }
  writeBlob(e) {
    this.writeUleb(BigInt(e.byteLength)), this.writeBytes(e);
  }
  writeList(e, t) {
    this.writeUleb(e.length);
    for (let n = 0;n < e.length; n++)
      t(e[n], n);
  }
  writeNullable(e, t) {
    if (e == null) {
      this.writeBool(false);
      return;
    }
    this.writeBool(true), t(e);
  }
  writeHugeInt(e) {
    let t = typeof e == "bigint" ? h(e) : e;
    this.writeSleb(t.upper), this.writeUleb(t.lower);
  }
  writeFixedInt8(e) {
    this.writeByte(e & 255);
  }
  writeFixedUint8(e) {
    this.writeByte(e);
  }
  writeFixedInt16(e) {
    let t = new Uint8Array(2);
    new DataView(t.buffer).setInt16(0, e, true), this.writeBytes(t);
  }
  writeFixedUint16(e) {
    let t = new Uint8Array(2);
    new DataView(t.buffer).setUint16(0, e, true), this.writeBytes(t);
  }
  writeFixedInt32(e) {
    let t = new Uint8Array(4);
    new DataView(t.buffer).setInt32(0, e, true), this.writeBytes(t);
  }
  writeFixedUint32(e) {
    let t = new Uint8Array(4);
    new DataView(t.buffer).setUint32(0, e, true), this.writeBytes(t);
  }
  writeFixedFloat32(e) {
    let t = new Uint8Array(4);
    new DataView(t.buffer).setFloat32(0, e, true), this.writeBytes(t);
  }
  writeFixedFloat64(e) {
    let t = new Uint8Array(8);
    new DataView(t.buffer).setFloat64(0, e, true), this.writeBytes(t);
  }
  writeFixedInt64(e) {
    let t = new Uint8Array(8);
    new DataView(t.buffer).setBigInt64(0, BigInt(e), true), this.writeBytes(t);
  }
  writeFixedUint64(e) {
    let t = new Uint8Array(8);
    new DataView(t.buffer).setBigUint64(0, g(e), true), this.writeBytes(t);
  }
  ensure(e) {
    let t = this.offset + e;
    if (t <= this.buffer.byteLength)
      return;
    let n = this.buffer.byteLength;
    for (;n < t; )
      n *= 2;
    let r = new Uint8Array(n);
    r.set(this.buffer), this.buffer = r;
  }
};
var p = class {
  bytes;
  view;
  offset = 0;
  constructor(e) {
    this.bytes = e, this.view = new DataView(e.buffer, e.byteOffset, e.byteLength);
  }
  get position() {
    return this.offset;
  }
  get remaining() {
    return this.bytes.byteLength - this.offset;
  }
  eof() {
    return this.remaining === 0;
  }
  assertEof() {
    if (!this.eof())
      throw new u(`Unexpected trailing bytes at offset ${this.offset}`);
  }
  readObject(e) {
    let t = e(this);
    return this.readEndObject(), t;
  }
  readEndObject() {
    let e = this.readFieldId();
    if (e !== 65535)
      throw new u(`Expected end of object at offset ${this.offset - 2}, got field ${e}`);
  }
  readFieldId() {
    this.ensure(2);
    let e = this.view.getUint16(this.offset, true);
    return this.offset += 2, e;
  }
  peekFieldId() {
    return this.ensure(2), this.view.getUint16(this.offset, true);
  }
  readRequiredField(e, t) {
    let n = this.readFieldId();
    if (n !== e)
      throw new u(`Expected field ${e} at offset ${this.offset - 2}, got ${n}`);
    return t();
  }
  readOptionalField(e, t, n) {
    return this.peekFieldId() === e ? (this.readFieldId(), t()) : n;
  }
  readByte() {
    return this.ensure(1), this.bytes[this.offset++];
  }
  readBytes(e) {
    if (!Number.isInteger(e) || e < 0)
      throw new u(`Invalid byte length ${e}`);
    this.ensure(e);
    let t = this.offset;
    return this.offset += e, this.bytes.slice(t, this.offset);
  }
  readBool() {
    let e = this.readByte();
    if (e !== 0 && e !== 1)
      throw new u(`Invalid boolean byte ${e}`);
    return e === 1;
  }
  readUlebBigInt() {
    let e = 0n, t = 0n;
    for (let n = 0;n < 10; n++) {
      let n = this.readByte();
      if (e |= BigInt(n & 127) << t, !(n & 128))
        return e;
      t += 7n;
    }
    throw new u("Unsigned LEB128 value is too long");
  }
  readUlebNumber() {
    return m(this.readUlebBigInt(), "unsigned LEB128");
  }
  readSlebBigInt() {
    let e = 0n, t = 0n, n = 0;
    for (let r = 0;r < 10; r++)
      if (n = this.readByte(), e |= BigInt(n & 127) << t, t += 7n, !(n & 128))
        return n & 64 && (e |= -1n << t), e;
    throw new u("Signed LEB128 value is too long");
  }
  readSlebNumber() {
    return m(this.readSlebBigInt(), "signed LEB128");
  }
  readString() {
    return ne.decode(this.readStringBytes());
  }
  readStringBytes() {
    let e = this.readUlebNumber();
    return this.readBytes(e);
  }
  readBlob() {
    let e = this.readUlebNumber();
    return this.readBytes(e);
  }
  readList(e) {
    let t = this.readUlebNumber(), n = [];
    for (let r = 0;r < t; r++)
      n.push(e(r));
    return n;
  }
  readNullable(e) {
    return this.readBool() ? e() : undefined;
  }
  readHugeInt() {
    return {
      upper: this.readSlebBigInt(),
      lower: this.readUlebBigInt()
    };
  }
  readFixedInt8() {
    return this.readByte() << 24 >> 24;
  }
  readFixedUint8() {
    return this.readByte();
  }
  readFixedInt16() {
    this.ensure(2);
    let e = this.view.getInt16(this.offset, true);
    return this.offset += 2, e;
  }
  readFixedUint16() {
    this.ensure(2);
    let e = this.view.getUint16(this.offset, true);
    return this.offset += 2, e;
  }
  readFixedInt32() {
    this.ensure(4);
    let e = this.view.getInt32(this.offset, true);
    return this.offset += 4, e;
  }
  readFixedUint32() {
    this.ensure(4);
    let e = this.view.getUint32(this.offset, true);
    return this.offset += 4, e;
  }
  readFixedFloat32() {
    this.ensure(4);
    let e = this.view.getFloat32(this.offset, true);
    return this.offset += 4, e;
  }
  readFixedFloat64() {
    this.ensure(8);
    let e = this.view.getFloat64(this.offset, true);
    return this.offset += 8, e;
  }
  readFixedInt64() {
    this.ensure(8);
    let e = this.view.getBigInt64(this.offset, true);
    return this.offset += 8, e;
  }
  readFixedUint64() {
    this.ensure(8);
    let e = this.view.getBigUint64(this.offset, true);
    return this.offset += 8, e;
  }
  ensure(e) {
    if (this.offset + e > this.bytes.byteLength)
      throw new u(`Unexpected end of input at offset ${this.offset}; needed ${e} byte(s), have ${this.remaining}`);
  }
};
function m(e, t) {
  if (e > BigInt(2 ** 53 - 1) || e < BigInt(-(2 ** 53 - 1)))
    throw new u(`${t} value ${e.toString()} exceeds JavaScript safe integer range`);
  return Number(e);
}
function h(e) {
  return {
    lower: BigInt.asUintN(64, e),
    upper: BigInt.asIntN(64, e >> 64n)
  };
}
function ie(e) {
  return BigInt.asIntN(64, e.upper) << 64n | BigInt.asUintN(64, e.lower);
}
function ae(e) {
  return BigInt.asUintN(64, e.upper) << 64n | BigInt.asUintN(64, e.lower);
}
function g(e) {
  let t = BigInt(e);
  if (t < 0n)
    throw new u(`Expected unsigned integer, got ${e.toString()}`);
  return t;
}
var _ = /* @__PURE__ */ function(e) {
  return e[e.BOOL = 1] = "BOOL", e[e.UINT8 = 2] = "UINT8", e[e.INT8 = 3] = "INT8", e[e.UINT16 = 4] = "UINT16", e[e.INT16 = 5] = "INT16", e[e.UINT32 = 6] = "UINT32", e[e.INT32 = 7] = "INT32", e[e.UINT64 = 8] = "UINT64", e[e.INT64 = 9] = "INT64", e[e.FLOAT = 11] = "FLOAT", e[e.DOUBLE = 12] = "DOUBLE", e[e.INTERVAL = 21] = "INTERVAL", e[e.LIST = 23] = "LIST", e[e.STRUCT = 24] = "STRUCT", e[e.ARRAY = 29] = "ARRAY", e[e.VARCHAR = 200] = "VARCHAR", e[e.UINT128 = 203] = "UINT128", e[e.INT128 = 204] = "INT128", e[e.UNKNOWN = 205] = "UNKNOWN", e[e.BIT = 206] = "BIT", e[e.INVALID = 255] = "INVALID", e;
}({});
var v = /* @__PURE__ */ function(e) {
  return e[e.INVALID = 0] = "INVALID", e[e.SQLNULL = 1] = "SQLNULL", e[e.UNKNOWN = 2] = "UNKNOWN", e[e.ANY = 3] = "ANY", e[e.UNBOUND = 4] = "UNBOUND", e[e.TEMPLATE = 5] = "TEMPLATE", e[e.TYPE = 6] = "TYPE", e[e.BOOLEAN = 10] = "BOOLEAN", e[e.TINYINT = 11] = "TINYINT", e[e.SMALLINT = 12] = "SMALLINT", e[e.INTEGER = 13] = "INTEGER", e[e.BIGINT = 14] = "BIGINT", e[e.DATE = 15] = "DATE", e[e.TIME = 16] = "TIME", e[e.TIMESTAMP_SEC = 17] = "TIMESTAMP_SEC", e[e.TIMESTAMP_MS = 18] = "TIMESTAMP_MS", e[e.TIMESTAMP = 19] = "TIMESTAMP", e[e.TIMESTAMP_NS = 20] = "TIMESTAMP_NS", e[e.DECIMAL = 21] = "DECIMAL", e[e.FLOAT = 22] = "FLOAT", e[e.DOUBLE = 23] = "DOUBLE", e[e.CHAR = 24] = "CHAR", e[e.VARCHAR = 25] = "VARCHAR", e[e.BLOB = 26] = "BLOB", e[e.INTERVAL = 27] = "INTERVAL", e[e.UTINYINT = 28] = "UTINYINT", e[e.USMALLINT = 29] = "USMALLINT", e[e.UINTEGER = 30] = "UINTEGER", e[e.UBIGINT = 31] = "UBIGINT", e[e.TIMESTAMP_TZ = 32] = "TIMESTAMP_TZ", e[e.TIMESTAMP_TZ_NS = 33] = "TIMESTAMP_TZ_NS", e[e.TIME_TZ = 34] = "TIME_TZ", e[e.TIME_NS = 35] = "TIME_NS", e[e.BIT = 36] = "BIT", e[e.STRING_LITERAL = 37] = "STRING_LITERAL", e[e.INTEGER_LITERAL = 38] = "INTEGER_LITERAL", e[e.BIGNUM = 39] = "BIGNUM", e[e.UHUGEINT = 49] = "UHUGEINT", e[e.HUGEINT = 50] = "HUGEINT", e[e.POINTER = 51] = "POINTER", e[e.VALIDITY = 53] = "VALIDITY", e[e.UUID = 54] = "UUID", e[e.GEOMETRY = 60] = "GEOMETRY", e[e.STRUCT = 100] = "STRUCT", e[e.LIST = 101] = "LIST", e[e.MAP = 102] = "MAP", e[e.TABLE = 103] = "TABLE", e[e.ENUM = 104] = "ENUM", e[e.AGGREGATE_STATE = 105] = "AGGREGATE_STATE", e[e.LAMBDA = 106] = "LAMBDA", e[e.UNION = 107] = "UNION", e[e.ARRAY = 108] = "ARRAY", e[e.VARIANT = 109] = "VARIANT", e[e.TUPLE = 110] = "TUPLE", e;
}({});
var y = /* @__PURE__ */ function(e) {
  return e[e.INVALID = 0] = "INVALID", e[e.GENERIC = 1] = "GENERIC", e[e.DECIMAL = 2] = "DECIMAL", e[e.STRING = 3] = "STRING", e[e.LIST = 4] = "LIST", e[e.STRUCT = 5] = "STRUCT", e[e.ENUM = 6] = "ENUM", e[e.UNBOUND = 7] = "UNBOUND", e[e.AGGREGATE_STATE = 8] = "AGGREGATE_STATE", e[e.ARRAY = 9] = "ARRAY", e[e.ANY = 10] = "ANY", e[e.INTEGER_LITERAL = 11] = "INTEGER_LITERAL", e[e.TEMPLATE = 12] = "TEMPLATE", e[e.GEO = 13] = "GEO", e;
}({});
function b(e, t) {
  return t ? {
    id: e,
    typeInfo: t
  } : { id: e };
}
var oe = {
  null: () => b(v.SQLNULL),
  boolean: () => b(v.BOOLEAN),
  tinyint: () => b(v.TINYINT),
  smallint: () => b(v.SMALLINT),
  integer: () => b(v.INTEGER),
  bigint: () => b(v.BIGINT),
  utinyint: () => b(v.UTINYINT),
  usmallint: () => b(v.USMALLINT),
  uinteger: () => b(v.UINTEGER),
  ubigint: () => b(v.UBIGINT),
  hugeint: () => b(v.HUGEINT),
  uhugeint: () => b(v.UHUGEINT),
  float: () => b(v.FLOAT),
  double: () => b(v.DOUBLE),
  char: (e) => e ? b(v.CHAR, {
    type: y.STRING,
    collation: e
  }) : b(v.CHAR),
  varchar: (e) => e ? b(v.VARCHAR, {
    type: y.STRING,
    collation: e
  }) : b(v.VARCHAR),
  blob: () => b(v.BLOB),
  bit: () => b(v.BIT),
  uuid: () => b(v.UUID),
  date: () => b(v.DATE),
  time: () => b(v.TIME),
  timeNs: () => b(v.TIME_NS),
  timeTz: () => b(v.TIME_TZ),
  timestamp: () => b(v.TIMESTAMP),
  timestampSeconds: () => b(v.TIMESTAMP_SEC),
  timestampMillis: () => b(v.TIMESTAMP_MS),
  timestampNanos: () => b(v.TIMESTAMP_NS),
  timestampTz: () => b(v.TIMESTAMP_TZ),
  timestampTzNanos: () => b(v.TIMESTAMP_TZ_NS),
  interval: () => b(v.INTERVAL),
  decimal: (e, t) => b(v.DECIMAL, {
    type: y.DECIMAL,
    width: e,
    scale: t
  }),
  list: (e) => b(v.LIST, {
    type: y.LIST,
    childType: e
  }),
  map: (e, t) => b(v.MAP, {
    type: y.LIST,
    childType: b(v.STRUCT, {
      type: y.STRUCT,
      childTypes: [{
        name: "key",
        type: e
      }, {
        name: "value",
        type: t
      }]
    })
  }),
  struct: (e) => b(v.STRUCT, {
    type: y.STRUCT,
    childTypes: e
  }),
  tuple: (e) => b(v.TUPLE, {
    type: y.STRUCT,
    childTypes: e.map((e) => ({
      name: "",
      type: e
    }))
  }),
  array: (e, t) => b(v.ARRAY, {
    type: y.ARRAY,
    childType: e,
    size: t
  }),
  enum: (e) => b(v.ENUM, {
    type: y.ENUM,
    values: e
  }),
  geometry: (e) => e ? b(v.GEOMETRY, {
    type: y.GEO,
    crs: e
  }) : b(v.GEOMETRY)
};
function x(e, t) {
  e.writeObject((e) => {
    e.writeField(100, () => e.writeUleb(t.id)), t.typeInfo && e.writeField(101, () => e.writeNullable(t.typeInfo, (t) => se(e, t)));
  });
}
function S(e) {
  return e.readObject((e) => {
    let t = e.readRequiredField(100, () => e.readUlebNumber()), n = e.readOptionalField(101, () => e.readNullable(() => ce(e)), undefined);
    return n ? {
      id: t,
      typeInfo: n
    } : { id: t };
  });
}
function se(e, t) {
  e.writeObject((e) => {
    switch (e.writeField(100, () => e.writeUleb(t.type)), t.alias && e.writeField(101, () => e.writeString(t.alias)), t.type) {
      case y.INVALID:
      case y.GENERIC:
        break;
      case y.DECIMAL:
        e.writeField(200, () => e.writeUleb(t.width)), e.writeField(201, () => e.writeUleb(t.scale));
        break;
      case y.STRING:
        e.writeField(200, () => e.writeString(t.collation ?? ""));
        break;
      case y.LIST:
        e.writeField(200, () => x(e, t.childType));
        break;
      case y.STRUCT:
        e.writeField(200, () => le(e, t.childTypes));
        break;
      case y.ENUM:
        e.writeField(200, () => e.writeUleb(t.values.length)), e.writeField(201, () => e.writeList(t.values, (t) => e.writeString(t)));
        break;
      case y.AGGREGATE_STATE:
        break;
      case y.ARRAY:
        e.writeField(200, () => x(e, t.childType)), e.writeField(201, () => e.writeUleb(t.size));
        break;
      case y.ANY:
        e.writeField(200, () => x(e, t.targetType)), e.writeField(201, () => e.writeUleb(t.castScore));
        break;
      case y.TEMPLATE:
        e.writeField(200, () => e.writeString(t.name));
        break;
      case y.INTEGER_LITERAL:
        throw new d("Encoding INTEGER_LITERAL type metadata is not supported");
      case y.GEO:
        e.writeField(200, () => de(e, t.crs ?? {}));
        break;
      case y.UNBOUND:
        t.name && e.writeField(200, () => e.writeString(t.name)), t.catalog && e.writeField(201, () => e.writeString(t.catalog)), t.schema && e.writeField(202, () => e.writeString(t.schema));
        break;
      default:
        he(t);
    }
  });
}
function ce(e) {
  return e.readObject((e) => {
    let t = e.readRequiredField(100, () => e.readUlebNumber()), n = e.readOptionalField(101, () => e.readString(), undefined);
    e.readOptionalField(103, () => e.readNullable(() => {
      throw new d("Extension type metadata is not supported by quack-ts");
    }), undefined);
    let r = n ? { alias: n } : {};
    switch (t) {
      case y.INVALID:
      case y.GENERIC:
        return {
          ...r,
          type: t
        };
      case y.DECIMAL:
        return {
          ...r,
          type: t,
          width: e.readOptionalField(200, () => e.readUlebNumber(), 0),
          scale: e.readOptionalField(201, () => e.readUlebNumber(), 0)
        };
      case y.STRING:
        return {
          ...r,
          type: t,
          collation: e.readOptionalField(200, () => e.readString(), "")
        };
      case y.LIST:
        return {
          ...r,
          type: t,
          childType: e.readRequiredField(200, () => S(e))
        };
      case y.STRUCT:
        return {
          ...r,
          type: t,
          childTypes: e.readOptionalField(200, () => ue(e), [])
        };
      case y.ENUM: {
        let n = e.readRequiredField(200, () => e.readUlebNumber()), i = e.readRequiredField(201, () => e.readList(() => e.readString()));
        if (i.length !== n)
          throw new u(`ENUM metadata declared ${n} values but serialized ${i.length}`);
        return {
          ...r,
          type: t,
          values: i
        };
      }
      case y.AGGREGATE_STATE: {
        let n = e.readOptionalField(200, () => e.readString(), undefined), i = e.readOptionalField(201, () => S(e), undefined), a = e.readOptionalField(202, () => e.readList(() => S(e)), undefined);
        return {
          ...r,
          type: t,
          ...A("functionName", n),
          ...A("returnType", i),
          ...A("boundArgumentTypes", a)
        };
      }
      case y.ARRAY:
        return {
          ...r,
          type: t,
          childType: e.readRequiredField(200, () => S(e)),
          size: e.readRequiredField(201, () => e.readUlebNumber())
        };
      case y.ANY:
        return {
          ...r,
          type: t,
          targetType: e.readRequiredField(200, () => S(e)),
          castScore: e.readRequiredField(201, () => e.readUlebBigInt())
        };
      case y.INTEGER_LITERAL:
        if (e.peekFieldId() === 200)
          throw new d("INTEGER_LITERAL type metadata contains a DuckDB Value, which is not supported");
        return {
          ...r,
          type: t
        };
      case y.TEMPLATE:
        return {
          ...r,
          type: t,
          name: e.readOptionalField(200, () => e.readString(), "")
        };
      case y.GEO:
        return {
          ...r,
          type: t,
          crs: e.readOptionalField(200, () => fe(e), {})
        };
      case y.UNBOUND:
        if (e.peekFieldId() === 204)
          throw new d("UNBOUND type metadata contains a ParsedExpression, which is not supported");
        let n = e.readOptionalField(200, () => e.readString(), undefined), i = e.readOptionalField(201, () => e.readString(), undefined), a = e.readOptionalField(202, () => e.readString(), undefined);
        return {
          ...r,
          type: t,
          ...A("name", n),
          ...A("catalog", i),
          ...A("schema", a)
        };
      default:
        throw new u(`Unknown ExtraTypeInfoType ${t}`);
    }
  });
}
function C(e) {
  switch (e.id) {
    case v.BOOLEAN:
      return _.BOOL;
    case v.TINYINT:
      return _.INT8;
    case v.UTINYINT:
      return _.UINT8;
    case v.SMALLINT:
      return _.INT16;
    case v.USMALLINT:
      return _.UINT16;
    case v.SQLNULL:
    case v.DATE:
    case v.INTEGER:
      return _.INT32;
    case v.UINTEGER:
      return _.UINT32;
    case v.BIGINT:
    case v.TIME:
    case v.TIME_NS:
    case v.TIMESTAMP:
    case v.TIMESTAMP_SEC:
    case v.TIMESTAMP_NS:
    case v.TIMESTAMP_MS:
    case v.TIME_TZ:
    case v.TIMESTAMP_TZ:
    case v.TIMESTAMP_TZ_NS:
      return _.INT64;
    case v.UBIGINT:
      return _.UINT64;
    case v.UHUGEINT:
      return _.UINT128;
    case v.HUGEINT:
    case v.UUID:
      return _.INT128;
    case v.FLOAT:
      return _.FLOAT;
    case v.DOUBLE:
      return _.DOUBLE;
    case v.DECIMAL:
      return pe(e);
    case v.BIGNUM:
    case v.VARCHAR:
    case v.CHAR:
    case v.BLOB:
    case v.BIT:
    case v.TYPE:
    case v.AGGREGATE_STATE:
    case v.GEOMETRY:
      return _.VARCHAR;
    case v.INTERVAL:
      return _.INTERVAL;
    case v.UNION:
    case v.VARIANT:
    case v.STRUCT:
    case v.TUPLE:
      return _.STRUCT;
    case v.LIST:
    case v.MAP:
      return _.LIST;
    case v.ARRAY:
      return _.ARRAY;
    case v.POINTER:
      return _.UINT64;
    case v.VALIDITY:
      return _.BIT;
    case v.ENUM:
      return me(e);
    default:
      return _.INVALID;
  }
}
function w(e) {
  switch (e) {
    case _.BOOL:
    case _.UINT8:
    case _.INT8:
    case _.UINT16:
    case _.INT16:
    case _.UINT32:
    case _.INT32:
    case _.UINT64:
    case _.INT64:
    case _.FLOAT:
    case _.DOUBLE:
    case _.INTERVAL:
    case _.UINT128:
    case _.INT128:
      return true;
    default:
      return false;
  }
}
function T(e) {
  switch (e) {
    case _.BOOL:
    case _.UINT8:
    case _.INT8:
      return 1;
    case _.UINT16:
    case _.INT16:
      return 2;
    case _.UINT32:
    case _.INT32:
    case _.FLOAT:
      return 4;
    case _.UINT64:
    case _.INT64:
    case _.DOUBLE:
      return 8;
    case _.INTERVAL:
    case _.UINT128:
    case _.INT128:
      return 16;
    default:
      throw new u(`Physical type ${e} is not fixed size`);
  }
}
function E(e) {
  let t = e.typeInfo;
  if (t?.type === y.LIST || t?.type === y.ARRAY)
    return t.childType;
  throw new u(`Logical type ${v[e.id] ?? e.id} does not have a child type`);
}
function D(e) {
  let t = e.typeInfo;
  if (t?.type === y.STRUCT)
    return t.childTypes;
  if (e.id === v.VARIANT || e.id === v.UNION)
    return [];
  throw new u(`Logical type ${v[e.id] ?? e.id} does not have struct children`);
}
function O(e) {
  let t = e.typeInfo;
  if (t?.type !== y.ARRAY)
    throw new u(`Logical type ${v[e.id] ?? e.id} is not an ARRAY`);
  return t.size;
}
function k(e) {
  let t = e.typeInfo;
  if (t?.type !== y.ENUM)
    throw new u(`Logical type ${v[e.id] ?? e.id} is not an ENUM`);
  return t.values;
}
function le(e, t) {
  e.writeList(t, (t) => {
    e.writeObject((e) => {
      e.writeField(0, () => e.writeString(t.name)), e.writeField(1, () => x(e, t.type));
    });
  });
}
function ue(e) {
  return e.readList(() => e.readObject((e) => ({
    name: e.readRequiredField(0, () => e.readString()),
    type: e.readRequiredField(1, () => S(e))
  })));
}
function de(e, t) {
  e.writeObject((e) => {
    t.definition && e.writeField(100, () => e.writeString(t.definition));
  });
}
function fe(e) {
  return e.readObject((e) => {
    let t = e.readOptionalField(100, () => e.readString(), undefined);
    return t === undefined ? {} : { definition: t };
  });
}
function pe(e) {
  let t = e.typeInfo;
  if (t?.type !== y.DECIMAL)
    throw new u("DECIMAL type is missing DecimalTypeInfo");
  if (t.width <= 4)
    return _.INT16;
  if (t.width <= 9)
    return _.INT32;
  if (t.width <= 18)
    return _.INT64;
  if (t.width <= 38)
    return _.INT128;
  throw new u(`Unsupported DECIMAL width ${t.width}`);
}
function me(e) {
  let t = k(e);
  return t.length <= 255 ? _.UINT8 : t.length <= 65535 ? _.UINT16 : _.UINT32;
}
function he(e) {
  throw new u(`Unhandled value ${String(e)}`);
}
function A(e, t) {
  return t === undefined ? {} : { [e]: t };
}
var j = /* @__PURE__ */ function(e) {
  return e[e.FLAT = 0] = "FLAT", e[e.FSST = 1] = "FSST", e[e.CONSTANT = 2] = "CONSTANT", e[e.DICTIONARY = 3] = "DICTIONARY", e[e.SEQUENCE = 4] = "SEQUENCE", e[e.SHREDDED = 5] = "SHREDDED", e;
}({});
function M(e) {
  return e.readObject((e) => e.readRequiredField(300, () => P(e)));
}
function N(e, t) {
  e.writeObject((e) => {
    e.writeField(300, () => F(e, t));
  });
}
function P(e) {
  return e.readObject((e) => {
    let t = e.readRequiredField(100, () => e.readUlebNumber()), n = e.readRequiredField(101, () => e.readList(() => S(e))), r = e.readRequiredField(102, () => e.readList((r) => {
      let i = n[r];
      if (!i)
        throw new u(`Column vector ${r} has no matching logical type`);
      return I(e, i, t);
    }));
    if (r.length !== n.length)
      throw new u(`DataChunk declared ${n.length} types but serialized ${r.length} columns`);
    return {
      rowCount: t,
      types: n,
      columns: r
    };
  });
}
function F(e, t) {
  if (t.types.length !== t.columns.length)
    throw new u("DataChunk type count must match column count");
  e.writeObject((e) => {
    e.writeField(100, () => e.writeUleb(t.rowCount)), e.writeField(101, () => e.writeList(t.types, (t) => x(e, t))), e.writeField(102, () => e.writeList(t.columns, (n, r) => {
      let i = t.types[r];
      if (!i)
        throw new u(`Column ${r} has no logical type`);
      if (n.values.length !== t.rowCount)
        throw new u(`Column ${r} has ${n.values.length} values, expected ${t.rowCount}`);
      L(e, i, n.values, t.rowCount);
    }));
  });
}
function I(e, t, n) {
  return e.readObject((e) => z(e, t, n));
}
function L(e, t, n, r) {
  e.writeObject((e) => ye(e, t, n, r));
}
function R(e, t = e.columnNames) {
  let n = t ?? e.columns.map((e, t) => `column${t}`), r = [];
  for (let t = 0;t < e.rowCount; t++) {
    let i = {};
    for (let r = 0;r < e.columns.length; r++) {
      let a = n[r] ?? `column${r}`, o = e.columns[r];
      if (!o)
        throw new u(`Missing column ${r}`);
      i[a] = o.values[t] ?? null;
    }
    r.push(i);
  }
  return r;
}
function ge(e, t) {
  return e.flatMap((e) => R(e, t ? [...t] : e.columnNames));
}
function _e(e) {
  let t = e.scale, n = e.value < 0n, r = n ? -e.value : e.value;
  if (t === 0)
    return `${n ? "-" : ""}${r.toString()}`;
  let i = 10n ** BigInt(t), a = r / i, o = (r % i).toString().padStart(t, "0");
  return `${n ? "-" : ""}${a.toString()}.${o}`;
}
function z(e, t, n) {
  let r = e.readOptionalField(90, () => e.readUlebNumber(), j.FLAT);
  switch (r) {
    case j.FLAT:
      return ve(e, t, n, r);
    case j.FSST:
      throw new d("FSST-compressed vectors are not supported by quack-ts");
    case j.SHREDDED:
      throw new d("Shredded VARIANT vectors are not supported by quack-ts; cast VARIANT values to VARCHAR or JSON");
    case j.CONSTANT: {
      let i = z(e, t, +(n > 0)).values[0] ?? null;
      return {
        type: t,
        vectorType: r,
        values: Array.from({ length: n }, () => i)
      };
    }
    case j.DICTIONARY: {
      let i = e.readRequiredField(91, () => Me(e, n)), a = z(e, t, e.readRequiredField(92, () => e.readUlebNumber()));
      return {
        type: t,
        vectorType: r,
        values: i.map((e) => {
          let t = a.values[e];
          if (t === undefined)
            throw new u(`Dictionary selection ${e} is out of range`);
          return t;
        })
      };
    }
    case j.SEQUENCE: {
      let i = e.readRequiredField(91, () => e.readSlebBigInt()), a = e.readRequiredField(92, () => e.readSlebBigInt());
      return {
        type: t,
        vectorType: r,
        values: Array.from({ length: n }, (e, n) => He(t, i + a * BigInt(n)))
      };
    }
    default:
      throw new u(`Unknown vector type ${r}`);
  }
}
function ve(e, t, n, r) {
  t.id === v.GEOMETRY && e.peekFieldId() === 99 && e.readRequiredField(99, () => e.readUlebNumber());
  let i = e.readRequiredField(100, () => e.readBool()) ? e.readRequiredField(101, () => Ne(e, n)) : undefined, a = C(t);
  if (w(a)) {
    let o = T(a) * n, s = e.readRequiredField(102, () => e.readBlob());
    if (s.byteLength !== o)
      throw new u(`Fixed-size vector data has ${s.byteLength} bytes, expected ${o}`);
    return {
      type: t,
      vectorType: r,
      values: be(t, a, s, n, i)
    };
  }
  switch (a) {
    case _.VARCHAR:
      return {
        type: t,
        vectorType: r,
        values: (e.peekFieldId() === 107 ? Ae(e, n) : ke(e, n)).map((e, n) => V(i, n) ? we(t, e) : null)
      };
    case _.STRUCT: {
      let a = D(t), o = e.readRequiredField(103, () => e.readList((t) => {
        let r = a[t];
        if (!r)
          throw new u(`STRUCT child vector ${t} has no matching type metadata`);
        return I(e, r.type, n);
      }));
      return {
        type: t,
        vectorType: r,
        values: Array.from({ length: n }, (e, n) => {
          if (!V(i, n))
            return null;
          if (t.id === v.TUPLE)
            return o.map((e) => e.values[n] ?? null);
          let r = {};
          for (let e = 0;e < a.length; e++) {
            let t = a[e], i = o[e];
            if (!t || !i)
              throw new u(`STRUCT child ${e} is incomplete`);
            r[t.name] = i.values[n] ?? null;
          }
          return r;
        })
      };
    }
    case _.LIST: {
      let a = e.readRequiredField(104, () => e.readUlebNumber()), o = e.readRequiredField(105, () => Fe(e, n)), s = E(t), c = e.readRequiredField(106, () => I(e, s, a));
      return {
        type: t,
        vectorType: r,
        values: o.map((e, t) => V(i, t) ? c.values.slice(e.offset, e.offset + e.length) : null)
      };
    }
    case _.ARRAY: {
      let a = e.readRequiredField(103, () => e.readUlebNumber()), o = O(t);
      if (a !== o)
        throw new u(`ARRAY vector serialized size ${a}, expected ${o}`);
      let s = E(t), c = e.readRequiredField(104, () => I(e, s, a * n));
      return {
        type: t,
        vectorType: r,
        values: Array.from({ length: n }, (e, t) => {
          if (!V(i, t))
            return null;
          let n = t * a;
          return c.values.slice(n, n + a);
        })
      };
    }
    default:
      throw new d(`Variable-width physical type ${_[a] ?? a} is not supported`);
  }
}
function ye(e, t, n, r) {
  if (n.length !== r)
    throw new u(`Vector value count ${n.length} does not match row count ${r}`);
  t.id === v.GEOMETRY && e.writeField(99, () => e.writeUleb(1));
  let i = n.map((e) => e !== null), a = i.some((e) => !e);
  e.writeField(100, () => e.writeBool(a)), a && e.writeField(101, () => e.writeBlob(Pe(i)));
  let o = C(t);
  if (w(o)) {
    let i = new f(Math.max(16, T(o) * r));
    for (let e of n)
      Se(i, t, o, e);
    e.writeField(102, () => e.writeBlob(i.toUint8Array()));
    return;
  }
  switch (o) {
    case _.VARCHAR: {
      let r = n.map((e) => Te(t, e));
      t.id === v.GEOMETRY ? e.writeField(102, () => e.writeList(r, (t) => e.writeStringBytes(t))) : je(e, r);
      return;
    }
    case _.STRUCT:
      Ee(e, t, n, r);
      return;
    case _.LIST:
      De(e, t, n);
      return;
    case _.ARRAY:
      Oe(e, t, n);
      return;
    default:
      throw new d(`Cannot encode physical type ${_[o] ?? o}`);
  }
}
function be(e, t, n, r, i) {
  let a = new p(n), o = [];
  for (let n = 0;n < r; n++) {
    let r = xe(a, e, t);
    o.push(V(i, n) ? r : null);
  }
  return a.assertEof(), o;
}
function xe(e, t, n) {
  switch (n) {
    case _.BOOL:
      return e.readFixedUint8() !== 0;
    case _.INT8:
      return e.readFixedInt8();
    case _.UINT8:
      return H(t, e.readFixedUint8());
    case _.INT16: {
      let n = e.readFixedInt16();
      return t.id === v.DECIMAL ? G(t, BigInt(n)) : n;
    }
    case _.UINT16:
      return H(t, e.readFixedUint16());
    case _.INT32: {
      let n = e.readFixedInt32();
      return t.id === v.DATE ? {
        kind: "date",
        days: n
      } : t.id === v.DECIMAL ? G(t, BigInt(n)) : n;
    }
    case _.UINT32:
      return H(t, e.readFixedUint32());
    case _.INT64:
      return W(t, e.readFixedInt64());
    case _.UINT64:
      return e.readFixedUint64();
    case _.FLOAT:
      return e.readFixedFloat32();
    case _.DOUBLE:
      return e.readFixedFloat64();
    case _.INT128: {
      let n = e.readFixedUint64(), r = e.readFixedInt64();
      if (t.id === v.UUID)
        return Ue(r, n);
      let i = ie({
        upper: r,
        lower: n
      });
      return t.id === v.DECIMAL ? G(t, i) : i;
    }
    case _.UINT128: {
      let t = e.readFixedUint64();
      return ae({
        upper: e.readFixedUint64(),
        lower: t
      });
    }
    case _.INTERVAL:
      return {
        kind: "interval",
        months: e.readFixedInt32(),
        days: e.readFixedInt32(),
        micros: e.readFixedInt64()
      };
    default:
      throw new d(`Cannot decode fixed physical type ${_[n] ?? n}`);
  }
}
function Se(e, t, n, r) {
  if (r === null) {
    Ce(e, n);
    return;
  }
  switch (n) {
    case _.BOOL:
      e.writeFixedUint8(+(r === true));
      return;
    case _.INT8:
      e.writeFixedInt8(Number(r));
      return;
    case _.UINT8:
      e.writeFixedUint8(U(t, r));
      return;
    case _.INT16:
      e.writeFixedInt16(Number(ze(t, r)));
      return;
    case _.UINT16:
      e.writeFixedUint16(U(t, r));
      return;
    case _.INT32:
      e.writeFixedInt32(Number(Be(t, r)));
      return;
    case _.UINT32:
      e.writeFixedUint32(U(t, r));
      return;
    case _.INT64:
      e.writeFixedInt64(Le(t, r));
      return;
    case _.UINT64:
      e.writeFixedUint64(q(r));
      return;
    case _.FLOAT:
      e.writeFixedFloat32(Number(r));
      return;
    case _.DOUBLE:
      e.writeFixedFloat64(Number(r));
      return;
    case _.INT128: {
      let n = t.id === v.UUID ? We(String(r)) : h(Re(t, r));
      e.writeFixedUint64(n.lower), e.writeFixedInt64(n.upper);
      return;
    }
    case _.UINT128: {
      let t = q(r);
      e.writeFixedUint64(BigInt.asUintN(64, t)), e.writeFixedUint64(BigInt.asUintN(64, t >> 64n));
      return;
    }
    case _.INTERVAL: {
      let t = r;
      e.writeFixedInt32(t.months ?? 0), e.writeFixedInt32(t.days ?? 0), e.writeFixedInt64(t.micros ?? 0n);
      return;
    }
    default:
      throw new d(`Cannot encode fixed physical type ${_[n] ?? n}`);
  }
}
function Ce(e, t) {
  e.writeBytes(new Uint8Array(T(t)));
}
function we(e, t) {
  switch (e.id) {
    case v.BLOB:
    case v.GEOMETRY:
    case v.BIT:
      return t;
    default:
      return new TextDecoder().decode(t);
  }
}
function Te(e, t) {
  if (t === null)
    return new Uint8Array;
  switch (e.id) {
    case v.BLOB:
    case v.GEOMETRY:
    case v.BIT:
      return t instanceof Uint8Array ? t : new TextEncoder().encode(String(t));
    default:
      return new TextEncoder().encode(String(t));
  }
}
function Ee(e, t, n, r) {
  let i = D(t), a = t.id === v.TUPLE;
  e.writeField(103, () => e.writeList(i, (t, i) => {
    let o = n.map((e) => a && Array.isArray(e) ? e[i] ?? null : e === null || Array.isArray(e) || typeof e != "object" || e instanceof Uint8Array ? null : e[t.name] ?? null);
    L(e, t.type, o, r);
  }));
}
function De(e, t, n) {
  let r = E(t), i = [], a = [];
  for (let e of n) {
    if (e === null) {
      i.push({
        offset: 0,
        length: 0
      });
      continue;
    }
    if (!Array.isArray(e))
      throw new u("LIST/MAP values must be arrays");
    let t = a.length;
    a.push(...e), i.push({
      offset: t,
      length: e.length
    });
  }
  e.writeField(104, () => e.writeUleb(a.length)), e.writeField(105, () => Ie(e, i)), e.writeField(106, () => L(e, r, a, a.length));
}
function Oe(e, t, n) {
  let r = E(t), i = O(t), a = [];
  for (let e of n) {
    if (e === null) {
      for (let e = 0;e < i; e++)
        a.push(null);
      continue;
    }
    if (!Array.isArray(e) || e.length !== i)
      throw new u(`ARRAY values must be arrays of length ${i}`);
    a.push(...e);
  }
  e.writeField(103, () => e.writeUleb(i)), e.writeField(104, () => L(e, r, a, a.length));
}
function ke(e, t) {
  let n = e.readRequiredField(102, () => e.readList(() => e.readStringBytes()));
  if (n.length !== t)
    throw new u(`String vector serialized ${n.length} entries for ${t} rows`);
  return n;
}
function Ae(e, t) {
  let n = e.readRequiredField(107, () => e.readUlebNumber()), r = e.readRequiredField(108, () => e.readBlob()), i = e.readRequiredField(109, () => e.readBlob());
  if (r.byteLength !== t * 4)
    throw new u(`String length data has ${r.byteLength} bytes, expected ${t * 4}`);
  if (i.byteLength !== n)
    throw new u(`String byte data has ${i.byteLength} bytes, expected ${n}`);
  let a = new DataView(r.buffer, r.byteOffset, r.byteLength), o = [], s = 0;
  for (let e = 0;e < t; e++) {
    let t = a.getUint32(e * 4, true);
    if (s + t > i.byteLength)
      throw new u("String lengths exceed the serialized string data");
    o.push(i.subarray(s, s + t)), s += t;
  }
  return o;
}
function je(e, t) {
  let n = new Uint8Array(t.length * 4), r = new DataView(n.buffer), i = 0;
  t.forEach((e, t) => {
    r.setUint32(t * 4, e.byteLength, true), i += e.byteLength;
  });
  let a = new Uint8Array(i), o = 0;
  for (let e of t)
    a.set(e, o), o += e.byteLength;
  e.writeField(107, () => e.writeUleb(i)), e.writeField(108, () => e.writeBlob(n)), e.writeField(109, () => e.writeBlob(a));
}
function Me(e, t) {
  let n = t * 4, r = e.readBlob();
  if (r.byteLength !== n)
    throw new u(`Selection vector has ${r.byteLength} bytes, expected ${n}`);
  let i = new DataView(r.buffer, r.byteOffset, r.byteLength);
  return Array.from({ length: t }, (e, t) => i.getUint32(t * 4, true));
}
function Ne(e, t) {
  let n = B(t), r = e.readBlob();
  if (r.byteLength !== n)
    throw new u(`Validity mask has ${r.byteLength} bytes, expected ${n}`);
  return Array.from({ length: t }, (e, t) => ((r[Math.floor(t / 8)] ?? 0) & 1 << t % 8) != 0);
}
function Pe(e) {
  let t = new Uint8Array(B(e.length)).fill(255);
  for (let n = 0;n < e.length; n++)
    if (!e[n]) {
      let e = Math.floor(n / 8);
      t[e] = (t[e] ?? 0) & ~(1 << n % 8);
    }
  return t;
}
function B(e) {
  return Math.ceil(e / 64) * 8;
}
function V(e, t) {
  return e ? e[t] === true : true;
}
function Fe(e, t) {
  let n = e.readList(() => e.readObject((e) => ({
    offset: e.readRequiredField(100, () => e.readUlebNumber()),
    length: e.readRequiredField(101, () => e.readUlebNumber())
  })));
  if (n.length !== t)
    throw new u(`LIST vector serialized ${n.length} entries for ${t} rows`);
  return n;
}
function Ie(e, t) {
  e.writeList(t, (t) => {
    e.writeObject((e) => {
      e.writeField(100, () => e.writeUleb(t.offset)), e.writeField(101, () => e.writeUleb(t.length));
    });
  });
}
function H(e, t) {
  if (e.id !== v.ENUM)
    return t;
  let n = k(e)[t];
  if (n === undefined)
    throw new u(`ENUM index ${t} is out of range`);
  return n;
}
function U(e, t) {
  if (e.id !== v.ENUM)
    return Number(t);
  if (typeof t == "number")
    return t;
  let n = k(e).indexOf(String(t));
  if (n < 0)
    throw new u(`Unknown ENUM value ${String(t)}`);
  return n;
}
function W(e, t) {
  switch (e.id) {
    case v.TIME:
      return {
        kind: "time",
        unit: "micros",
        value: t
      };
    case v.TIME_NS:
      return {
        kind: "time",
        unit: "nanos",
        value: t
      };
    case v.TIME_TZ:
      return {
        kind: "time_tz",
        bits: t
      };
    case v.TIMESTAMP_SEC:
      return {
        kind: "timestamp",
        unit: "seconds",
        value: t
      };
    case v.TIMESTAMP_MS:
      return {
        kind: "timestamp",
        unit: "millis",
        value: t
      };
    case v.TIMESTAMP:
      return {
        kind: "timestamp",
        unit: "micros",
        value: t
      };
    case v.TIMESTAMP_NS:
      return {
        kind: "timestamp",
        unit: "nanos",
        value: t
      };
    case v.TIMESTAMP_TZ:
      return {
        kind: "timestamp",
        unit: "micros",
        value: t,
        timezone: "utc"
      };
    case v.TIMESTAMP_TZ_NS:
      return {
        kind: "timestamp",
        unit: "nanos",
        value: t,
        timezone: "utc"
      };
    case v.DECIMAL:
      return G(e, t);
    default:
      return t;
  }
}
function Le(e, t) {
  if (e.id === v.DECIMAL)
    return K(e, t);
  if (typeof t == "object" && t && !(t instanceof Uint8Array) && !Array.isArray(t)) {
    let e = t;
    if (e.kind === "time" || e.kind === "timestamp")
      return BigInt(e.value);
    if (e.kind === "time_tz")
      return BigInt(e.bits);
  }
  return q(t);
}
function Re(e, t) {
  return e.id === v.DECIMAL ? K(e, t) : q(t);
}
function ze(e, t) {
  return e.id === v.DECIMAL ? K(e, t) : q(t);
}
function Be(e, t) {
  return e.id === v.DATE ? typeof t == "object" && t && !Array.isArray(t) && !(t instanceof Uint8Array) ? BigInt(t.days) : q(t) : ze(e, t);
}
function G(e, t) {
  let n = e.typeInfo;
  if (n?.type !== y.DECIMAL)
    throw new u("DECIMAL value is missing DecimalTypeInfo");
  return {
    kind: "decimal",
    value: t,
    width: n.width,
    scale: n.scale
  };
}
function K(e, t) {
  if (typeof t == "object" && t && !Array.isArray(t) && !(t instanceof Uint8Array)) {
    let e = t;
    if (e.kind === "decimal")
      return BigInt(e.value);
  }
  return typeof t == "string" ? Ve(e, t) : q(t);
}
function Ve(e, t) {
  let n = e.typeInfo;
  if (n?.type !== y.DECIMAL)
    throw new u("DECIMAL value is missing DecimalTypeInfo");
  let r = t.trim(), i = r.startsWith("-"), [a = "0", o = ""] = (i || r.startsWith("+") ? r.slice(1) : r).split("."), s = o.padEnd(n.scale, "0").slice(0, n.scale), c = BigInt(`${a}${s}` || "0");
  return i ? -c : c;
}
function q(e) {
  if (typeof e == "bigint")
    return e;
  if (typeof e == "number" || typeof e == "string" || typeof e == "boolean")
    return BigInt(e);
  throw new u(`Cannot convert ${String(e)} to bigint`);
}
function He(e, t) {
  switch (e.id) {
    case v.INTEGER:
    case v.DATE:
      return e.id === v.DATE ? {
        kind: "date",
        days: Number(t)
      } : Number(t);
    case v.BIGINT:
      return t;
    default:
      return W(e, t);
  }
}
function Ue(e, t) {
  let n = `${(BigInt.asUintN(64, e) ^ 1n << 63n).toString(16).padStart(16, "0")}${t.toString(16).padStart(16, "0")}`;
  return `${n.slice(0, 8)}-${n.slice(8, 12)}-${n.slice(12, 16)}-${n.slice(16, 20)}-${n.slice(20)}`;
}
function We(e) {
  let t = e.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(t))
    throw new u(`Invalid UUID string ${e}`);
  let n = BigInt(`0x${t.slice(0, 16)}`), r = BigInt(`0x${t.slice(16)}`);
  return {
    upper: BigInt.asIntN(64, n ^ 1n << 63n),
    lower: r
  };
}
var J = /* @__PURE__ */ function(e) {
  return e[e.INVALID = 0] = "INVALID", e[e.CONNECTION_REQUEST = 1] = "CONNECTION_REQUEST", e[e.CONNECTION_RESPONSE = 2] = "CONNECTION_RESPONSE", e[e.PREPARE_REQUEST = 3] = "PREPARE_REQUEST", e[e.PREPARE_RESPONSE = 4] = "PREPARE_RESPONSE", e[e.FETCH_REQUEST = 7] = "FETCH_REQUEST", e[e.FETCH_RESPONSE = 8] = "FETCH_RESPONSE", e[e.SEND_DATA_REQUEST = 9] = "SEND_DATA_REQUEST", e[e.SUCCESS_RESPONSE = 10] = "SUCCESS_RESPONSE", e[e.DISCONNECT_MESSAGE = 11] = "DISCONNECT_MESSAGE", e[e.CANCEL_REQUEST = 12] = "CANCEL_REQUEST", e[e.SEND_DATA_RESPONSE = 14] = "SEND_DATA_RESPONSE", e[e.ACKNOWLEDGEMENT = 15] = "ACKNOWLEDGEMENT", e[e.HEARTBEAT_REQUEST = 16] = "HEARTBEAT_REQUEST", e[e.ERROR_RESPONSE = 100] = "ERROR_RESPONSE", e;
}({});
function Ge(e) {
  let t = new f;
  return qe(t, e), Ye(t, e), Ze(t, e), t.toUint8Array();
}
function Ke(e) {
  let t = new p(e), n = Xe(t, Je(t));
  return t.assertEof(), n;
}
function qe(e, t) {
  e.writeObject((e) => {
    e.writeField(1, () => e.writeUleb(t.type)), t.connectionId && e.writeField(2, () => e.writeString(t.connectionId)), e.writeField(3, () => e.writeUleb(t.clientQueryId ?? 18446744073709551615n));
  });
}
function Je(e) {
  return e.readObject((e) => {
    let t = e.readRequiredField(1, () => e.readUlebNumber()), n = e.readOptionalField(2, () => e.readString(), ""), r = e.readRequiredField(3, () => e.readUlebBigInt());
    return {
      type: t,
      ...n ? { connectionId: n } : {},
      ...r === 18446744073709551615n ? {} : { clientQueryId: r }
    };
  });
}
function Ye(e, t) {
  switch (t.type) {
    case J.CONNECTION_REQUEST:
      e.writeObject((e) => {
        Y(e, 1, t.authString), Y(e, 2, t.clientDuckdbVersion), Y(e, 3, t.clientPlatform), X(e, 4, t.minSupportedQuackVersion), X(e, 5, t.maxSupportedQuackVersion), Y(e, 6, t.clientId), X(e, 7, t.heartbeatTimeoutSeconds);
      });
      return;
    case J.CONNECTION_RESPONSE:
      e.writeObject((e) => {
        Y(e, 1, t.serverDuckdbVersion), Y(e, 2, t.serverPlatform), X(e, 3, t.quackVersion), X(e, 4, t.heartbeatTimeoutSeconds);
      });
      return;
    case J.PREPARE_REQUEST:
      e.writeObject((e) => {
        Y(e, 1, t.sql), e.writeField(2, () => e.writeHugeInt(t.queryUuid)), Z(e, 3, t.inlineRows);
      });
      return;
    case J.PREPARE_RESPONSE:
      e.writeObject((e) => {
        t.resultTypes.length && e.writeField(1, () => e.writeList(t.resultTypes, (t) => x(e, t))), t.resultNames.length && e.writeField(2, () => e.writeList(t.resultNames, (t) => e.writeString(t))), t.needsMoreFetch && e.writeField(3, () => e.writeBool(t.needsMoreFetch)), t.results.length && e.writeField(4, () => et(e, t.results)), e.writeField(5, () => e.writeHugeInt(t.queryUuid));
      });
      return;
    case J.FETCH_REQUEST:
      e.writeObject((e) => {
        e.writeField(1, () => e.writeHugeInt(t.queryUuid)), X(e, 2, t.batchIndex), X(e, 3, t.ackIndex);
      });
      return;
    case J.FETCH_RESPONSE:
      e.writeObject((e) => {
        X(e, 1, t.results.length), Z(e, 2, t.totalBatches), Z(e, 3, t.batchIndex);
      });
      return;
    case J.SEND_DATA_REQUEST:
      e.writeObject((e) => {
        Y(e, 1, t.streamId), X(e, 2, t.chunks.length), Z(e, 3, t.totalBatches), Z(e, 4, t.batchIndex);
      });
      return;
    case J.SEND_DATA_RESPONSE:
      e.writeObject((e) => {
        e.writeField(1, () => e.writeUleb(t.acceptBudget ?? 18446744073709551615n));
      });
      return;
    case J.CANCEL_REQUEST:
      e.writeObject((e) => {
        e.writeField(1, () => e.writeHugeInt(t.queryUuid));
      });
      return;
    case J.ACKNOWLEDGEMENT:
      e.writeObject((e) => {
        nt(t.queryUuid) || e.writeField(1, () => e.writeHugeInt(t.queryUuid));
      });
      return;
    case J.SUCCESS_RESPONSE:
    case J.DISCONNECT_MESSAGE:
    case J.HEARTBEAT_REQUEST:
      e.writeObject(() => {
        return;
      });
      return;
    case J.ERROR_RESPONSE:
      e.writeObject((e) => {
        Y(e, 1, t.message), Y(e, 2, t.exceptionType);
        let n = Object.entries(t.extraInfo ?? {});
        n.length && e.writeField(3, () => e.writeList(n, ([t, n]) => e.writeObject((e) => {
          e.writeField(0, () => e.writeString(t)), e.writeField(1, () => e.writeString(n));
        }))), t.mustInvalidate && e.writeField(4, () => e.writeBool(true));
      });
      return;
    default:
      throw new u(`Cannot encode unsupported message type ${t.type}`);
  }
}
function Xe(e, t) {
  switch (t.type) {
    case J.CONNECTION_REQUEST:
      return e.readObject((e) => ({
        ...t,
        type: J.CONNECTION_REQUEST,
        ...$("authString", e.readOptionalField(1, () => e.readString(), undefined)),
        ...$("clientDuckdbVersion", e.readOptionalField(2, () => e.readString(), undefined)),
        ...$("clientPlatform", e.readOptionalField(3, () => e.readString(), undefined)),
        minSupportedQuackVersion: e.readOptionalField(4, () => e.readUlebBigInt(), 0n),
        maxSupportedQuackVersion: e.readOptionalField(5, () => e.readUlebBigInt(), 0n),
        ...$("clientId", e.readOptionalField(6, () => e.readString(), undefined)),
        heartbeatTimeoutSeconds: e.readOptionalField(7, () => e.readUlebBigInt(), 0n)
      }));
    case J.CONNECTION_RESPONSE:
      return e.readObject((e) => ({
        ...t,
        type: J.CONNECTION_RESPONSE,
        ...$("serverDuckdbVersion", e.readOptionalField(1, () => e.readString(), undefined)),
        ...$("serverPlatform", e.readOptionalField(2, () => e.readString(), undefined)),
        ...$("quackVersion", e.readOptionalField(3, () => e.readUlebBigInt(), undefined)),
        ...$("heartbeatTimeoutSeconds", e.readOptionalField(4, () => e.readUlebBigInt(), undefined))
      }));
    case J.PREPARE_REQUEST:
      return e.readObject((e) => {
        let n = e.readOptionalField(1, () => e.readString(), ""), r = e.readRequiredField(2, () => e.readHugeInt()), i = Q(e, 3);
        return {
          ...t,
          type: J.PREPARE_REQUEST,
          sql: n,
          queryUuid: r,
          ...$("inlineRows", i)
        };
      });
    case J.PREPARE_RESPONSE:
      return e.readObject((e) => ({
        ...t,
        type: J.PREPARE_RESPONSE,
        resultTypes: e.readOptionalField(1, () => e.readList(() => S(e)), []),
        resultNames: e.readOptionalField(2, () => e.readList(() => e.readString()), []),
        needsMoreFetch: e.readOptionalField(3, () => e.readBool(), false),
        results: e.readOptionalField(4, () => $e(e), []),
        queryUuid: e.readRequiredField(5, () => e.readHugeInt())
      }));
    case J.FETCH_REQUEST:
      return e.readObject((e) => ({
        ...t,
        type: J.FETCH_REQUEST,
        queryUuid: e.readRequiredField(1, () => e.readHugeInt()),
        batchIndex: e.readOptionalField(2, () => e.readUlebBigInt(), 0n),
        ackIndex: e.readOptionalField(3, () => e.readUlebBigInt(), 0n)
      }));
    case J.FETCH_RESPONSE: {
      let n = e.readObject((e) => ({
        chunkCount: e.readOptionalField(1, () => e.readUlebNumber(), 0),
        totalBatches: Q(e, 2),
        batchIndex: Q(e, 3)
      }));
      return {
        ...t,
        type: J.FETCH_RESPONSE,
        results: Qe(e, n.chunkCount),
        ...$("batchIndex", n.batchIndex),
        ...$("totalBatches", n.totalBatches)
      };
    }
    case J.SEND_DATA_REQUEST: {
      let n = e.readObject((e) => ({
        streamId: e.readOptionalField(1, () => e.readString(), ""),
        chunkCount: e.readOptionalField(2, () => e.readUlebNumber(), 0),
        totalBatches: Q(e, 3),
        batchIndex: Q(e, 4)
      }));
      return {
        ...t,
        type: J.SEND_DATA_REQUEST,
        streamId: n.streamId,
        chunks: Qe(e, n.chunkCount),
        ...$("batchIndex", n.batchIndex),
        ...$("totalBatches", n.totalBatches)
      };
    }
    case J.SEND_DATA_RESPONSE:
      return e.readObject((e) => ({
        ...t,
        type: J.SEND_DATA_RESPONSE,
        ...$("acceptBudget", Q(e, 1))
      }));
    case J.CANCEL_REQUEST:
      return e.readObject((e) => ({
        ...t,
        type: J.CANCEL_REQUEST,
        queryUuid: e.readRequiredField(1, () => e.readHugeInt())
      }));
    case J.ACKNOWLEDGEMENT:
      return e.readObject((e) => ({
        ...t,
        type: J.ACKNOWLEDGEMENT,
        queryUuid: e.readOptionalField(1, () => e.readHugeInt(), {
          upper: 0n,
          lower: 0n
        })
      }));
    case J.SUCCESS_RESPONSE:
      return e.readObject(() => ({
        ...t,
        type: J.SUCCESS_RESPONSE
      }));
    case J.DISCONNECT_MESSAGE:
      return e.readObject(() => ({
        ...t,
        type: J.DISCONNECT_MESSAGE
      }));
    case J.HEARTBEAT_REQUEST:
      return e.readObject(() => ({
        ...t,
        type: J.HEARTBEAT_REQUEST
      }));
    case J.ERROR_RESPONSE:
      return e.readObject((e) => {
        let n = e.readOptionalField(1, () => e.readString(), ""), r = e.readOptionalField(2, () => e.readString(), undefined), i = e.readOptionalField(3, () => tt(e), undefined), a = e.readOptionalField(4, () => e.readBool(), false);
        return {
          ...t,
          type: J.ERROR_RESPONSE,
          message: n,
          ...$("exceptionType", r),
          ...$("extraInfo", i),
          ...a ? { mustInvalidate: a } : {}
        };
      });
    default:
      throw new u(`Cannot decode unsupported message type ${t.type}`);
  }
}
function Ze(e, t) {
  let n = t.type === J.FETCH_RESPONSE ? t.results : t.type === J.SEND_DATA_REQUEST ? t.chunks : [];
  for (let t of n)
    F(e, t);
}
function Qe(e, t) {
  let n = [];
  for (let r = 0;r < t; r++)
    n.push(P(e));
  return n;
}
function $e(e) {
  return e.readList(() => {
    let t = e.readNullable(() => M(e));
    if (!t)
      throw new u("Encountered null DataChunk pointer in result list");
    return t;
  });
}
function et(e, t) {
  e.writeList(t, (t) => e.writeNullable(t, (t) => N(e, t)));
}
function tt(e) {
  let t = {};
  return e.readList(() => e.readObject((e) => {
    let n = e.readRequiredField(0, () => e.readString());
    t[n] = e.readRequiredField(1, () => e.readString());
  })), t;
}
function Y(e, t, n) {
  n !== undefined && n !== "" && e.writeField(t, () => e.writeString(n));
}
function X(e, t, n) {
  n !== undefined && BigInt(n) !== 0n && e.writeField(t, () => e.writeUleb(n));
}
function Z(e, t, n) {
  n !== undefined && e.writeField(t, () => e.writeUleb(n));
}
function Q(e, t) {
  let n = e.readOptionalField(t, () => e.readUlebBigInt(), a);
  return n === 18446744073709551615n ? undefined : n;
}
function nt(e) {
  return typeof e == "bigint" ? e === 0n : e.upper === 0n && e.lower === 0n;
}
function $(e, t) {
  return t === undefined ? {} : { [e]: t };
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/constants.js
var MAGIC = Uint8Array.of(65, 82, 82, 79, 87, 49);
var EOS = Uint8Array.of(255, 255, 255, 255, 0, 0, 0, 0);
var Version = {
  V1: 0,
  V2: 1,
  V3: 2,
  V4: 3,
  V5: 4
};
var Endianness = {
  Little: 0,
  Big: 1
};
var MessageHeader = {
  NONE: 0,
  Schema: 1,
  DictionaryBatch: 2,
  RecordBatch: 3,
  Tensor: 4,
  SparseTensor: 5
};
var Type = {
  Dictionary: -1,
  NONE: 0,
  Null: 1,
  Int: 2,
  Float: 3,
  Binary: 4,
  Utf8: 5,
  Bool: 6,
  Decimal: 7,
  Date: 8,
  Time: 9,
  Timestamp: 10,
  Interval: 11,
  List: 12,
  Struct: 13,
  Union: 14,
  FixedSizeBinary: 15,
  FixedSizeList: 16,
  Map: 17,
  Duration: 18,
  LargeBinary: 19,
  LargeUtf8: 20,
  LargeList: 21,
  RunEndEncoded: 22,
  BinaryView: 23,
  Utf8View: 24,
  ListView: 25,
  LargeListView: 26
};
var Precision = {
  HALF: 0,
  SINGLE: 1,
  DOUBLE: 2
};
var DateUnit = {
  DAY: 0,
  MILLISECOND: 1
};
var TimeUnit = {
  SECOND: 0,
  MILLISECOND: 1,
  MICROSECOND: 2,
  NANOSECOND: 3
};
var IntervalUnit = {
  YEAR_MONTH: 0,
  DAY_TIME: 1,
  MONTH_DAY_NANO: 2
};
var UnionMode = {
  Sparse: 0,
  Dense: 1
};
var CompressionType = {
  LZ4_FRAME: 0,
  ZSTD: 1
};
var BodyCompressionMethod = {
  BUFFER: 0
};
// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/util/arrays.js
var uint8Array = Uint8Array;
var uint16Array = Uint16Array;
var uint32Array = Uint32Array;
var uint64Array = BigUint64Array;
var int8Array = Int8Array;
var int16Array = Int16Array;
var int32Array = Int32Array;
var int64Array = BigInt64Array;
var float32Array = Float32Array;
var float64Array = Float64Array;
function objectToString(value) {
  return Object.prototype.toString.call(value);
}
function isArrayBufferLike(data) {
  return objectToString(data) === "[object ArrayBuffer]" || objectToString(data) === "[object SharedArrayBuffer]";
}
function isUint8Array(value) {
  return objectToString(value) === "[object Uint8Array]";
}
function intArrayType(bitWidth, signed) {
  const i = Math.log2(bitWidth) - 3;
  return (signed ? [int8Array, int16Array, int32Array, int64Array] : [uint8Array, uint16Array, uint32Array, uint64Array])[i];
}
function bisect(offsets, index) {
  let a = 0;
  let b = offsets.length;
  if (b <= 2147483648) {
    do {
      const mid = a + b >>> 1;
      if (offsets[mid] <= index)
        a = mid + 1;
      else
        b = mid;
    } while (a < b);
  } else {
    do {
      const mid = Math.trunc((a + b) / 2);
      if (offsets[mid] <= index)
        a = mid + 1;
      else
        b = mid;
    } while (a < b);
  }
  return a;
}
function resize(array, newLength, offset = 0) {
  const newArray = new array.constructor(newLength);
  newArray.set(array, offset);
  return newArray;
}
function grow(array, index, shift) {
  while (array.length <= index) {
    array = resize(array, array.length << 1, shift ? array.length : 0);
  }
  return array;
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/util/objects.js
function check(value, test, message) {
  if (test(value))
    return value;
  throw new Error(message(value));
}
function checkOneOf(value, set, message) {
  set = Array.isArray(set) ? set : Object.values(set);
  return check(value, (value) => set.includes(value), message ?? (() => `${value} must be one of ${set}`));
}
function keyFor(object, value) {
  for (const [key, val] of Object.entries(object)) {
    if (val === value)
      return key;
  }
  return "<Unknown>";
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/data-types.js
var invalidDataType = (typeId) => `Unsupported data type: "${keyFor(Type, typeId)}" (id ${typeId})`;
var field = (name, type, nullable = true, metadata = null) => ({
  name,
  type,
  nullable,
  metadata
});
function isField(value) {
  return Object.hasOwn(value, "name") && isDataType(value.type);
}
function isDataType(value) {
  return typeof value?.typeId === "number";
}
function asField(value, defaultName = "", defaultNullable = true) {
  return isField(value) ? value : field(defaultName, check(value, isDataType, () => `Data type expected.`), defaultNullable);
}
var basicType = (typeId) => ({ typeId });
var dictionary = (type, indexType, ordered = false, id = -1) => ({
  typeId: Type.Dictionary,
  id,
  dictionary: type,
  indices: indexType || int32(),
  ordered
});
var nullType = () => basicType(Type.Null);
var int = (bitWidth = 32, signed = true) => ({
  typeId: Type.Int,
  bitWidth: checkOneOf(bitWidth, [8, 16, 32, 64]),
  signed,
  values: intArrayType(bitWidth, signed)
});
var int8 = () => int(8);
var int16 = () => int(16);
var int32 = () => int(32);
var int64 = () => int(64);
var uint8 = () => int(8, false);
var uint16 = () => int(16, false);
var uint32 = () => int(32, false);
var uint64 = () => int(64, false);
var float = (precision = 2) => ({
  typeId: Type.Float,
  precision: checkOneOf(precision, Precision),
  values: [uint16Array, float32Array, float64Array][precision]
});
var float32 = () => float(Precision.SINGLE);
var float64 = () => float(Precision.DOUBLE);
var binary = () => ({
  typeId: Type.Binary,
  offsets: int32Array
});
var utf8 = () => ({
  typeId: Type.Utf8,
  offsets: int32Array
});
var bool = () => basicType(Type.Bool);
var decimal = (precision, scale, bitWidth = 128) => ({
  typeId: Type.Decimal,
  precision,
  scale,
  bitWidth: checkOneOf(bitWidth, [32, 64, 128, 256]),
  values: bitWidth === 32 ? int32Array : uint64Array
});
var decimal32 = (precision, scale) => decimal(precision, scale, 32);
var decimal64 = (precision, scale) => decimal(precision, scale, 64);
var decimal128 = (precision, scale) => decimal(precision, scale, 128);
var decimal256 = (precision, scale) => decimal(precision, scale, 256);
var date = (unit) => ({
  typeId: Type.Date,
  unit: checkOneOf(unit, DateUnit),
  values: unit === DateUnit.DAY ? int32Array : int64Array
});
var dateDay = () => date(DateUnit.DAY);
var time = (unit = TimeUnit.MILLISECOND) => {
  unit = checkOneOf(unit, TimeUnit);
  const bitWidth = unit === TimeUnit.SECOND || unit === TimeUnit.MILLISECOND ? 32 : 64;
  return {
    typeId: Type.Time,
    unit,
    bitWidth,
    values: bitWidth === 32 ? int32Array : int64Array
  };
};
var timeMicrosecond = () => time(TimeUnit.MICROSECOND);
var timeNanosecond = () => time(TimeUnit.NANOSECOND);
var timestamp = (unit = TimeUnit.MILLISECOND, timezone = null) => ({
  typeId: Type.Timestamp,
  unit: checkOneOf(unit, TimeUnit),
  timezone,
  values: int64Array
});
var interval = (unit = IntervalUnit.MONTH_DAY_NANO) => ({
  typeId: Type.Interval,
  unit: checkOneOf(unit, IntervalUnit),
  values: unit === IntervalUnit.MONTH_DAY_NANO ? undefined : int32Array
});
var list = (child) => ({
  typeId: Type.List,
  children: [asField(child)],
  offsets: int32Array
});
var struct = (children) => ({
  typeId: Type.Struct,
  children: Array.isArray(children) && children.length > 0 && isField(children[0]) ? children : Object.entries(children).map(([name, type]) => field(name, type))
});
var union = (mode, children, typeIds, typeIdForValue) => {
  typeIds ??= children.map((v, i) => i);
  return {
    typeId: Type.Union,
    mode: checkOneOf(mode, UnionMode),
    typeIds,
    typeMap: typeIds.reduce((m, id, i) => (m[id] = i, m), {}),
    children: children.map((v, i) => asField(v, `_${i}`)),
    typeIdForValue,
    offsets: int32Array
  };
};
var fixedSizeBinary = (stride) => ({
  typeId: Type.FixedSizeBinary,
  stride
});
var fixedSizeList = (child, stride) => ({
  typeId: Type.FixedSizeList,
  stride,
  children: [asField(child)]
});
var mapType = (keysSorted, child) => ({
  typeId: Type.Map,
  keysSorted,
  children: [child],
  offsets: int32Array
});
var map = (keyField, valueField, keysSorted = false) => mapType(keysSorted, field("entries", struct([asField(keyField, "key", false), asField(valueField, "value")]), false));
var duration = (unit = TimeUnit.MILLISECOND) => ({
  typeId: Type.Duration,
  unit: checkOneOf(unit, TimeUnit),
  values: int64Array
});
var largeBinary = () => ({
  typeId: Type.LargeBinary,
  offsets: int64Array
});
var largeUtf8 = () => ({
  typeId: Type.LargeUtf8,
  offsets: int64Array
});
var largeList = (child) => ({
  typeId: Type.LargeList,
  children: [asField(child)],
  offsets: int64Array
});
var runEndEncoded = (runsField, valuesField) => ({
  typeId: Type.RunEndEncoded,
  children: [
    check(asField(runsField, "run_ends"), (field) => field.type.typeId === Type.Int, () => "Run-ends must have an integer type."),
    asField(valuesField, "values")
  ]
});
var listView = (child) => ({
  typeId: Type.ListView,
  children: [asField(child, "value")],
  offsets: int32Array
});
var largeListView = (child) => ({
  typeId: Type.LargeListView,
  children: [asField(child, "value")],
  offsets: int64Array
});
// ../../node_modules/.bun/@uwdata+wk-geojson@0.0.1/node_modules/@uwdata/wk-geojson/dist/wkb-to-geojson.js
var TYPES = {
  1: "Point",
  2: "LineString",
  3: "Polygon",
  4: "MultiPoint",
  5: "MultiLineString",
  6: "MultiPolygon",
  7: "GeometryCollection"
};
var EWKB_Z = 2147483648;
var EWKB_M = 1073741824;
var EWKB_SRID = 536870912;
var EMPTY = new Uint8Array;
var EMPTY_VIEW = new DataView(EMPTY.buffer);
var bytes = EMPTY;
var view = EMPTY_VIEW;
var pos = 0;
var littleEndian = false;
var hasZ = false;
var stride = 16;
var fail = (message) => {
  throw new Error(`Invalid WKB: ${message} at byte ${pos}`);
};
var need = (n) => {
  if (pos + n > bytes.length)
    fail("unexpected end of input");
};
var uint322 = () => {
  need(4);
  const v = view.getUint32(pos, littleEndian);
  pos += 4;
  return v;
};
var float642 = (offset) => view.getFloat64(pos + offset, littleEndian);
var array = (item) => {
  const n = uint322();
  if (n > bytes.length - pos)
    fail(`invalid count ${n}`);
  const items = new Array(n);
  for (let i = 0;i < n; ++i)
    items[i] = item();
  return items;
};
var position = () => {
  need(stride);
  const p = hasZ ? [float642(0), float642(8), float642(16)] : [float642(0), float642(8)];
  pos += stride;
  return p;
};
var point = () => {
  const p = position();
  return Number.isNaN(p[0]) ? [] : p;
};
var line = () => array(position);
var polygon = () => array(line);
var header = () => {
  need(1);
  const order = bytes[pos];
  if (order > 1)
    fail(`invalid byte order ${order}`);
  littleEndian = order === 1;
  pos += 1;
  const code = uint322();
  const iso = code & 268435455;
  const dim = Math.floor(iso / 1000);
  hasZ = (code & EWKB_Z) !== 0 || dim === 1 || dim === 3;
  const hasM = (code & EWKB_M) !== 0 || dim === 2 || dim === 3;
  stride = 8 * (2 + Number(hasZ) + Number(hasM));
  if (code & EWKB_SRID)
    uint322();
  return dim <= 3 && TYPES[iso % 1000] || fail(`unknown geometry type ${code}`);
};
var member = (type, read) => () => {
  if (header() !== type)
    fail(`expected a ${type} member`);
  return read();
};
var pointMember = member("Point", point);
var lineMember = member("LineString", line);
var polygonMember = member("Polygon", polygon);
var geometry = () => {
  const type = header();
  switch (type) {
    case "Point":
      return { type, coordinates: point() };
    case "LineString":
      return { type, coordinates: line() };
    case "Polygon":
      return { type, coordinates: polygon() };
    case "MultiPoint":
      return { type, coordinates: array(pointMember) };
    case "MultiLineString":
      return { type, coordinates: array(lineMember) };
    case "MultiPolygon":
      return { type, coordinates: array(polygonMember) };
    case "GeometryCollection":
      return { type, geometries: array(geometry) };
  }
};
function wkbToGeoJSON(input) {
  bytes = input;
  view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  pos = 0;
  try {
    const result = geometry();
    if (pos < bytes.length)
      fail("unexpected trailing bytes");
    return result;
  } finally {
    bytes = EMPTY;
    view = EMPTY_VIEW;
  }
}
// ../../node_modules/.bun/@uwdata+wk-geojson@0.0.1/node_modules/@uwdata/wk-geojson/dist/wkt-to-geojson.js
var TYPES2 = {
  POINT: "Point",
  MULTIPOINT: "MultiPoint",
  LINESTRING: "LineString",
  MULTILINESTRING: "MultiLineString",
  POLYGON: "Polygon",
  MULTIPOLYGON: "MultiPolygon",
  GEOMETRYCOLLECTION: "GeometryCollection"
};
var isLetter = (c) => c >= 65 && c <= 90 || c >= 97 && c <= 122;
var isNumeric = (c) => c >= 48 && c <= 57 || c === 43 || c === 45 || c === 46 || c === 69 || c === 101;
var wkt = "";
var pos2 = 0;
var token = "";
var value = NaN;
var dropM = false;
var scan = () => {
  while (wkt.charCodeAt(pos2) <= 32)
    pos2++;
  const start = pos2;
  const c = wkt.charCodeAt(pos2);
  value = NaN;
  if (isLetter(c)) {
    while (isLetter(wkt.charCodeAt(++pos2)))
      ;
    token = wkt.slice(start, pos2).toUpperCase();
  } else if (isNumeric(c)) {
    while (isNumeric(wkt.charCodeAt(++pos2)))
      ;
    token = wkt.slice(start, pos2);
    value = Number(token);
  } else {
    token = wkt.charAt(pos2++);
  }
};
var atNumber = () => !Number.isNaN(value);
var next = () => {
  const t = token;
  scan();
  return t;
};
var fail2 = (expected) => {
  throw new Error(`Invalid WKT: expected ${expected}, found "${token || "end of input"}"`);
};
var accept = (t) => token === t ? (scan(), true) : false;
var expect = (t) => {
  if (!accept(t))
    fail2(`"${t}"`);
};
var list2 = (item) => {
  if (accept("EMPTY"))
    return [];
  expect("(");
  const items = [item()];
  while (accept(","))
    items.push(item());
  expect(")");
  return items;
};
var coordinate = () => {
  if (!atNumber())
    fail2("a coordinate");
  const v = value;
  scan();
  return v;
};
var position2 = () => {
  const x = coordinate();
  const y = coordinate();
  if (!atNumber())
    return [x, y];
  const z = coordinate();
  if (atNumber())
    coordinate();
  else if (dropM)
    return [x, y];
  return [x, y, z];
};
var point2 = () => {
  const [p = [], ...rest] = list2(position2);
  if (rest.length)
    fail2('")"');
  return p;
};
var ring = () => list2(position2);
var polygon2 = () => list2(ring);
var multiPoint = () => atNumber() ? position2() : point2();
var geometry2 = () => {
  const suffix = TYPES2[token] ? null : /^([A-Z]+?)(ZM|Z|M)$/.exec(token);
  const type = TYPES2[suffix ? suffix[1] : token] ?? fail2("a geometry type");
  scan();
  const dim = suffix ? suffix[2] : ["Z", "M", "ZM"].includes(token) ? next() : "";
  dropM = dim.endsWith("M");
  switch (type) {
    case "Point":
      return { type, coordinates: point2() };
    case "MultiPoint":
      return { type, coordinates: list2(multiPoint) };
    case "LineString":
      return { type, coordinates: list2(position2) };
    case "MultiLineString":
    case "Polygon":
      return { type, coordinates: list2(ring) };
    case "MultiPolygon":
      return { type, coordinates: list2(polygon2) };
    case "GeometryCollection":
      return { type, geometries: list2(geometry2) };
  }
};
function wktToGeoJSON(input) {
  wkt = input;
  pos2 = /^\s*SRID=\d+\s*;/i.exec(input)?.[0].length ?? 0;
  try {
    scan();
    const result = geometry2();
    if (token)
      fail2("end of input");
    return result;
  } finally {
    wkt = token = "";
  }
}
// ../../node_modules/.bun/@uwdata+wk-geojson@0.0.1/node_modules/@uwdata/wk-geojson/dist/geojson-to-wkb.js
var CODES = {
  Point: 1,
  LineString: 2,
  Polygon: 3,
  MultiPoint: 4,
  MultiLineString: 5,
  MultiPolygon: 6,
  GeometryCollection: 7
};
var INITIAL_SIZE = 1024;
var MAX_RETAINED = 1 << 20;
var buffer = new Uint8Array(INITIAL_SIZE);
var view2 = new DataView(buffer.buffer);
var pos3 = 0;
var dims = 2;
var reserve = (n) => {
  if (pos3 + n <= buffer.length)
    return;
  const grown = new Uint8Array(Math.max(2 * buffer.length, pos3 + n));
  grown.set(buffer);
  buffer = grown;
  view2 = new DataView(grown.buffer);
};
var uint323 = (v) => {
  reserve(4);
  view2.setUint32(pos3, v, true);
  pos3 += 4;
};
var header2 = (type) => {
  reserve(5);
  buffer[pos3] = 1;
  view2.setUint32(pos3 + 1, CODES[type] + (dims === 3 ? 1000 : 0), true);
  pos3 += 5;
};
var array2 = (items, write) => {
  uint323(items.length);
  for (const item of items)
    write(item);
};
var position3 = (p) => {
  view2.setFloat64(pos3, p[0], true);
  view2.setFloat64(pos3 + 8, p[1], true);
  if (dims === 3)
    view2.setFloat64(pos3 + 16, p[2], true);
  pos3 += 8 * dims;
};
var EMPTY_POINT = [NaN, NaN, NaN];
var point3 = (p) => {
  reserve(8 * dims);
  position3(p.length ? p : EMPTY_POINT);
};
var line2 = (positions) => {
  const n = positions.length;
  reserve(4 + 8 * dims * n);
  uint323(n);
  for (let i = 0;i < n; ++i)
    position3(positions[i]);
};
var polygon3 = (rings) => array2(rings, line2);
var member2 = (type, write) => (item) => {
  header2(type);
  write(item);
};
var pointMember2 = member2("Point", point3);
var lineMember2 = member2("LineString", line2);
var polygonMember2 = member2("Polygon", polygon3);
// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/util/numbers.js
var f64 = new float64Array(2);
var buf = f64.buffer;
var i64 = new int64Array(buf);
var u32 = new uint32Array(buf);
var i32 = new int32Array(buf);
var u8 = new uint8Array(buf);
function toNumber(value) {
  if (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER) {
    throw Error(`BigInt exceeds integer number representation: ${value}`);
  }
  return Number(value);
}
function divide(num, div) {
  return Number(num / div) + Number(num % div) / Number(div);
}
var asUint64 = (v) => BigInt.asUintN(64, v);
function fromDecimal64(buf, offset) {
  return BigInt.asIntN(64, buf[offset]);
}
function fromDecimal128(buf, offset) {
  const i = offset << 1;
  let x;
  if (BigInt.asIntN(64, buf[i + 1]) < 0) {
    x = asUint64(~buf[i]) | asUint64(~buf[i + 1]) << 64n;
    x = -(x + 1n);
  } else {
    x = buf[i] | buf[i + 1] << 64n;
  }
  return x;
}
function fromDecimal256(buf, offset) {
  const i = offset << 2;
  let x;
  if (BigInt.asIntN(64, buf[i + 3]) < 0) {
    x = asUint64(~buf[i]) | asUint64(~buf[i + 1]) << 64n | asUint64(~buf[i + 2]) << 128n | asUint64(~buf[i + 3]) << 192n;
    x = -(x + 1n);
  } else {
    x = buf[i] | buf[i + 1] << 64n | buf[i + 2] << 128n | buf[i + 3] << 192n;
  }
  return x;
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/util/strings.js
var textDecoder = new TextDecoder("utf-8");
var textEncoder = new TextEncoder;
function decodeUtf8(buf) {
  return textDecoder.decode(buf);
}
function encodeUtf8(str) {
  return textEncoder.encode(str);
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/util/read.js
var SIZEOF_INT = 4;
var SIZEOF_SHORT = 2;
function decodeBit(bitmap, index) {
  return (bitmap[index >> 3] & 1 << index % 8) !== 0;
}
function readObject(buf, index) {
  const pos = index + readInt32(buf, index);
  const vtable = pos - readInt32(buf, pos);
  const size = readInt16(buf, vtable);
  return (index, read, fallback = null) => {
    if (index < size) {
      const off = readInt16(buf, vtable + index);
      if (off)
        return read(buf, pos + off);
    }
    return fallback;
  };
}
function readOffset(buf, offset) {
  return offset;
}
function readBoolean(buf, offset) {
  return !!readInt8(buf, offset);
}
function readInt8(buf, offset) {
  return readUint8(buf, offset) << 24 >> 24;
}
function readUint8(buf, offset) {
  return buf[offset];
}
function readInt16(buf, offset) {
  return readUint16(buf, offset) << 16 >> 16;
}
function readUint16(buf, offset) {
  return buf[offset] | buf[offset + 1] << 8;
}
function readInt32(buf, offset) {
  return buf[offset] | buf[offset + 1] << 8 | buf[offset + 2] << 16 | buf[offset + 3] << 24;
}
function readUint32(buf, offset) {
  return readInt32(buf, offset) >>> 0;
}
function readInt64(buf, offset) {
  return toNumber(BigInt.asIntN(64, BigInt(readUint32(buf, offset)) + (BigInt(readUint32(buf, offset + SIZEOF_INT)) << 32n)));
}
function readString(buf, index) {
  let offset = index + readInt32(buf, index);
  const length = readInt32(buf, offset);
  offset += SIZEOF_INT;
  return decodeUtf8(buf.subarray(offset, offset + length));
}
function readVector(buf, offset, stride, extract) {
  if (!offset)
    return [];
  const base = offset + readInt32(buf, offset);
  return Array.from({ length: readInt32(buf, base) }, (_, i) => extract(buf, base + SIZEOF_INT + i * stride));
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/util/struct.js
var RowIndex = Symbol("rowIndex");
function proxyFactory(names, batches) {

  class RowObject {
    constructor(index) {
      this[RowIndex] = index;
    }
    toJSON() {
      return structObject(names, batches, this[RowIndex]);
    }
  }
  const proto = RowObject.prototype;
  for (let i = 0;i < names.length; ++i) {
    if (Object.hasOwn(proto, names[i]))
      continue;
    const batch = batches[i];
    Object.defineProperty(proto, names[i], {
      get() {
        return batch.at(this[RowIndex]);
      },
      enumerable: true
    });
  }
  return (index) => new RowObject(index);
}
function objectFactory(names, batches) {
  return (index) => structObject(names, batches, index);
}
function structObject(names, batches, index) {
  const obj = {};
  for (let i = 0;i < names.length; ++i) {
    obj[names[i]] = batches[i].at(index);
  }
  return obj;
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/batch.js
function isDirectBatch(batch) {
  return batch instanceof DirectBatch;
}

class Batch {
  static ArrayType = null;
  constructor({
    length,
    nullCount,
    type,
    validity,
    values,
    offsets,
    sizes,
    children
  }) {
    this.length = length;
    this.nullCount = nullCount;
    this.type = type;
    this.validity = validity;
    this.values = values;
    this.offsets = offsets;
    this.sizes = sizes;
    this.children = children;
    if (!nullCount || !this.validity) {
      this.at = (index) => this.value(index);
    }
  }
  get [Symbol.toStringTag]() {
    return "Batch";
  }
  at(index) {
    return this.isValid(index) ? this.value(index) : null;
  }
  isValid(index) {
    return decodeBit(this.validity, index);
  }
  value(index) {
    return this.values[index];
  }
  slice(start, end) {
    const n = end - start;
    const values = Array(n);
    for (let i = 0;i < n; ++i) {
      values[i] = this.at(start + i);
    }
    return values;
  }
  *[Symbol.iterator]() {
    for (let i = 0;i < this.length; ++i) {
      yield this.at(i);
    }
  }
}

class DirectBatch extends Batch {
  constructor(options) {
    super(options);
    const { length, values } = this;
    this.values = values.subarray(0, length);
  }
  slice(start, end) {
    return this.nullCount ? super.slice(start, end) : this.values.subarray(start, end);
  }
  [Symbol.iterator]() {
    return this.nullCount ? super[Symbol.iterator]() : this.values[Symbol.iterator]();
  }
}

class NumberBatch extends Batch {
  static ArrayType = float64Array;
}

class ArrayBatch extends Batch {
  static ArrayType = Array;
}

class NullBatch extends ArrayBatch {
  value(index) {
    return null;
  }
}

class Int64Batch extends NumberBatch {
  value(index) {
    return toNumber(this.values[index]);
  }
}

class Float16Batch extends NumberBatch {
  value(index) {
    const v = this.values[index];
    const expo = (v & 31744) >> 10;
    const sigf = (v & 1023) / 1024;
    const sign = (-1) ** ((v & 32768) >> 15);
    switch (expo) {
      case 31:
        return sign * (sigf ? Number.NaN : 1 / 0);
      case 0:
        return sign * (sigf ? 0.00006103515625 * sigf : 0);
    }
    return sign * 2 ** (expo - 15) * (1 + sigf);
  }
}

class BoolBatch extends ArrayBatch {
  value(index) {
    return decodeBit(this.values, index);
  }
}

class Decimal32NumberBatch extends NumberBatch {
  constructor(options) {
    super(options);
    const { scale } = this.type;
    this.scale = 10 ** scale;
  }
  value(index) {
    return this.values[index] / this.scale;
  }
}

class DecimalBatch extends Batch {
  constructor(options) {
    super(options);
    const { bitWidth, scale } = this.type;
    this.decimal = bitWidth === 64 ? fromDecimal64 : bitWidth === 128 ? fromDecimal128 : fromDecimal256;
    this.scale = 10n ** BigInt(scale);
  }
}

class DecimalNumberBatch extends DecimalBatch {
  static ArrayType = float64Array;
  value(index) {
    return divide(this.decimal(this.values, index), this.scale);
  }
}

class DecimalBigIntBatch extends DecimalBatch {
  static ArrayType = Array;
  value(index) {
    return this.decimal(this.values, index);
  }
}

class DateBatch extends ArrayBatch {
  constructor(batch) {
    super(batch);
    this.source = batch;
  }
  value(index) {
    return new Date(this.source.value(index));
  }
}

class DateDayBatch extends NumberBatch {
  value(index) {
    return 86400000 * this.values[index];
  }
}
var DateDayMillisecondBatch = Int64Batch;

class TimestampSecondBatch extends Int64Batch {
  value(index) {
    return super.value(index) * 1000;
  }
}
var TimestampMillisecondBatch = Int64Batch;

class TimestampMicrosecondBatch extends Int64Batch {
  value(index) {
    return divide(this.values[index], 1000n);
  }
}

class TimestampNanosecondBatch extends Int64Batch {
  value(index) {
    return divide(this.values[index], 1000000n);
  }
}

class IntervalDayTimeBatch extends ArrayBatch {
  value(index) {
    const values = this.values;
    return values.subarray(index << 1, index + 1 << 1);
  }
}

class IntervalMonthDayNanoBatch extends ArrayBatch {
  value(index) {
    const values = this.values;
    const base = index << 4;
    return Float64Array.of(readInt32(values, base), readInt32(values, base + 4), readInt64(values, base + 8));
  }
}
var offset32 = ({ values, offsets }, index) => values.subarray(offsets[index], offsets[index + 1]);
var offset64 = ({ values, offsets }, index) => values.subarray(toNumber(offsets[index]), toNumber(offsets[index + 1]));

class BinaryBatch extends ArrayBatch {
  value(index) {
    return offset32(this, index);
  }
}

class LargeBinaryBatch extends ArrayBatch {
  value(index) {
    return offset64(this, index);
  }
}

class Utf8Batch extends ArrayBatch {
  value(index) {
    return decodeUtf8(offset32(this, index));
  }
}

class LargeUtf8Batch extends ArrayBatch {
  value(index) {
    return decodeUtf8(offset64(this, index));
  }
}

class WKBGeoJSONBatch extends ArrayBatch {
  constructor(batch) {
    super(batch);
    this.source = batch;
  }
  value(index) {
    return wkbToGeoJSON(this.source.value(index));
  }
}

class WKTGeoJSONBatch extends ArrayBatch {
  constructor(batch) {
    super(batch);
    this.source = batch;
  }
  value(index) {
    return wktToGeoJSON(this.source.value(index));
  }
}

class ListBatch extends ArrayBatch {
  value(index) {
    const offsets = this.offsets;
    return this.children[0].slice(offsets[index], offsets[index + 1]);
  }
}

class LargeListBatch extends ArrayBatch {
  value(index) {
    const offsets = this.offsets;
    return this.children[0].slice(toNumber(offsets[index]), toNumber(offsets[index + 1]));
  }
}

class ListViewBatch extends ArrayBatch {
  value(index) {
    const a = this.offsets[index];
    const b = a + this.sizes[index];
    return this.children[0].slice(a, b);
  }
}

class LargeListViewBatch extends ArrayBatch {
  value(index) {
    const a = this.offsets[index];
    const b = a + this.sizes[index];
    return this.children[0].slice(toNumber(a), toNumber(b));
  }
}

class FixedBatch extends ArrayBatch {
  constructor(options) {
    super(options);
    this.stride = this.type.stride;
  }
}

class FixedBinaryBatch extends FixedBatch {
  value(index) {
    const { stride, values } = this;
    return values.subarray(index * stride, (index + 1) * stride);
  }
}

class FixedListBatch extends FixedBatch {
  value(index) {
    const { children, stride } = this;
    return children[0].slice(index * stride, (index + 1) * stride);
  }
}
function pairs({ children, offsets }, index) {
  const [keys, vals] = children[0].children;
  const start = offsets[index];
  const end = offsets[index + 1];
  const entries = [];
  for (let i = start;i < end; ++i) {
    entries.push([keys.at(i), vals.at(i)]);
  }
  return entries;
}

class MapEntryBatch extends ArrayBatch {
  value(index) {
    return pairs(this, index);
  }
}

class MapBatch extends ArrayBatch {
  value(index) {
    return new Map(pairs(this, index));
  }
}

class SparseUnionBatch extends ArrayBatch {
  constructor({ typeIds, ...options }) {
    super(options);
    this.typeIds = typeIds;
    this.typeMap = this.type.typeMap;
  }
  value(index, offset = index) {
    const { typeIds, children, typeMap } = this;
    return children[typeMap[typeIds[index]]].at(offset);
  }
}

class DenseUnionBatch extends SparseUnionBatch {
  value(index) {
    return super.value(index, this.offsets[index]);
  }
}

class StructBatch extends ArrayBatch {
  constructor(options, factory = objectFactory) {
    super(options);
    this.names = this.type.children.map((child) => child.name);
    this.factory = factory(this.names, this.children);
  }
  value(index) {
    return this.factory(index);
  }
}

class StructProxyBatch extends StructBatch {
  constructor(options) {
    super(options, proxyFactory);
  }
}

class RunEndEncodedBatch extends ArrayBatch {
  value(index) {
    const [{ values: runs }, vals] = this.children;
    return vals.at(bisect(runs, index));
  }
}

class DictionaryBatch extends ArrayBatch {
  setDictionary(dictionary) {
    this.dictionary = dictionary;
    this.cache = dictionary.cache();
    return this;
  }
  value(index) {
    return this.cache[this.key(index)];
  }
  key(index) {
    return this.values[index];
  }
}

class ViewBatch extends ArrayBatch {
  constructor({ data, ...options }) {
    super(options);
    this.data = data;
  }
  view(index) {
    const { values, data } = this;
    const offset = index << 4;
    let start = offset + 4;
    let buf = values;
    const length = readInt32(buf, offset);
    if (length > 12) {
      start = readInt32(buf, offset + 12);
      buf = data[readInt32(buf, offset + 8)];
    }
    return buf.subarray(start, start + length);
  }
}

class BinaryViewBatch extends ViewBatch {
  value(index) {
    return this.view(index);
  }
}

class Utf8ViewBatch extends ViewBatch {
  value(index) {
    return decodeUtf8(this.view(index));
  }
}
// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/column.js
function columnBuilder(type) {
  let data = [];
  return {
    add(batch) {
      data.push(batch);
      return this;
    },
    clear: () => data = [],
    done: () => new Column(data, type)
  };
}

class Column {
  constructor(data, type = data[0]?.type) {
    this.type = type;
    this.length = data.reduce((m, c) => m + c.length, 0);
    this.nullCount = data.reduce((m, c) => m + c.nullCount, 0);
    this.data = data;
    const n = data.length;
    const offsets = new Int32Array(n + 1);
    if (n === 1) {
      const [batch] = data;
      offsets[1] = batch.length;
      this.at = (index) => batch.at(index);
    } else {
      for (let i = 0, s = 0;i < n; ++i) {
        offsets[i + 1] = s += data[i].length;
      }
    }
    this.offsets = offsets;
  }
  get [Symbol.toStringTag]() {
    return "Column";
  }
  [Symbol.iterator]() {
    const data = this.data;
    return data.length === 1 ? data[0][Symbol.iterator]() : batchedIterator(data);
  }
  at(index) {
    const { data, offsets } = this;
    const i = bisect(offsets, index) - 1;
    return data[i]?.at(index - offsets[i]);
  }
  get(index) {
    return this.at(index);
  }
  toArray() {
    const { length, nullCount, data } = this;
    const copy = !nullCount && isDirectBatch(data[0]);
    const n = data.length;
    if (copy && n === 1) {
      return data[0].values;
    }
    const ArrayType = !n || nullCount > 0 ? Array : data[0].constructor.ArrayType ?? data[0].values.constructor;
    const array = new ArrayType(length);
    return copy ? copyArray(array, data) : extractArray(array, data);
  }
  cache() {
    return this._cache ?? (this._cache = this.toArray());
  }
}
function* batchedIterator(data) {
  for (let i = 0;i < data.length; ++i) {
    const iter = data[i][Symbol.iterator]();
    for (let next = iter.next();!next.done; next = iter.next()) {
      yield next.value;
    }
  }
}
function copyArray(array, data) {
  for (let i = 0, offset = 0;i < data.length; ++i) {
    const { values } = data[i];
    array.set(values, offset);
    offset += values.length;
  }
  return array;
}
function extractArray(array, data) {
  let index = -1;
  for (let i = 0;i < data.length; ++i) {
    const batch = data[i];
    for (let j = 0;j < batch.length; ++j) {
      array[++index] = batch.at(j);
    }
  }
  return array;
}
// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/table.js
class Table {
  constructor(schema, children, useProxy = false) {
    const names = schema.fields.map((f) => f.name);
    this.schema = schema;
    this.names = names;
    this.children = children;
    this.factory = useProxy ? proxyFactory : objectFactory;
    const gen = [];
    this.getFactory = (b) => gen[b] ?? (gen[b] = this.factory(names, children.map((c) => c.data[b])));
  }
  get [Symbol.toStringTag]() {
    return "Table";
  }
  get numCols() {
    return this.names.length;
  }
  get numRows() {
    return this.children[0]?.length ?? 0;
  }
  getChildAt(index) {
    return this.children[index];
  }
  getChild(name) {
    const i = this.names.findIndex((x) => x === name);
    return i > -1 ? this.children[i] : undefined;
  }
  selectAt(indices, as = []) {
    const { children, factory, schema } = this;
    const { fields } = schema;
    return new Table({
      ...schema,
      fields: indices.map((i, j) => renameField(fields[i], as[j]))
    }, indices.map((i) => children[i]), factory === proxyFactory);
  }
  select(names, as) {
    const all = this.names;
    const indices = names.map((name) => all.indexOf(name));
    return this.selectAt(indices, as);
  }
  toColumns() {
    const { children, names } = this;
    const cols = {};
    names.forEach((name, i) => cols[name] = children[i]?.toArray() ?? []);
    return cols;
  }
  toArray() {
    const { children, getFactory, numRows } = this;
    const data = children[0]?.data ?? [];
    const output = Array(numRows);
    for (let b = 0, row = -1;b < data.length; ++b) {
      const f = getFactory(b);
      for (let i = 0;i < data[b].length; ++i) {
        output[++row] = f(i);
      }
    }
    return output;
  }
  *[Symbol.iterator]() {
    const { children, getFactory } = this;
    const data = children[0]?.data ?? [];
    for (let b = 0;b < data.length; ++b) {
      const f = getFactory(b);
      for (let i = 0;i < data[b].length; ++i) {
        yield f(i);
      }
    }
  }
  at(index) {
    const { children, getFactory, numRows } = this;
    if (index < 0 || index >= numRows)
      return null;
    const [{ offsets }] = children;
    const b = bisect(offsets, index) - 1;
    return getFactory(b)(index - offsets[b]);
  }
  get(index) {
    return this.at(index);
  }
}
function renameField(field, name) {
  return name != null && name !== field.name ? { ...field, name } : field;
}
// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/batch-type.js
function batchType(type, options = {}, metadata = null) {
  const { typeId, bitWidth, mode, precision, unit } = type;
  const { useBigInt, useBigIntTimestamp, useDate, useDecimalInt, useGeoJSON, useMap, useProxy } = options;
  const ext = useGeoJSON ? metadata?.get("ARROW:extension:name") : null;
  const wkb = ext === "geoarrow.wkb" && WKBGeoJSONBatch;
  const wkt = ext === "geoarrow.wkt" && WKTGeoJSONBatch;
  switch (typeId) {
    case Type.Null:
      return NullBatch;
    case Type.Bool:
      return BoolBatch;
    case Type.Int:
    case Type.Time:
    case Type.Duration:
      return useBigInt || bitWidth < 64 ? DirectBatch : Int64Batch;
    case Type.Float:
      return precision ? DirectBatch : Float16Batch;
    case Type.Date:
      return wrap(unit === DateUnit.DAY ? DateDayBatch : DateDayMillisecondBatch, useDate && DateBatch);
    case Type.Timestamp:
      return useBigIntTimestamp ? DirectBatch : wrap(unit === TimeUnit.SECOND ? TimestampSecondBatch : unit === TimeUnit.MILLISECOND ? TimestampMillisecondBatch : unit === TimeUnit.MICROSECOND ? TimestampMicrosecondBatch : TimestampNanosecondBatch, useDate && DateBatch);
    case Type.Decimal:
      return bitWidth === 32 ? useDecimalInt ? DirectBatch : Decimal32NumberBatch : useDecimalInt ? DecimalBigIntBatch : DecimalNumberBatch;
    case Type.Interval:
      return unit === IntervalUnit.DAY_TIME ? IntervalDayTimeBatch : unit === IntervalUnit.YEAR_MONTH ? DirectBatch : IntervalMonthDayNanoBatch;
    case Type.FixedSizeBinary:
      return FixedBinaryBatch;
    case Type.Utf8:
      return wrap(Utf8Batch, wkt);
    case Type.LargeUtf8:
      return wrap(LargeUtf8Batch, wkt);
    case Type.Binary:
      return wrap(BinaryBatch, wkb);
    case Type.LargeBinary:
      return wrap(LargeBinaryBatch, wkb);
    case Type.BinaryView:
      return wrap(BinaryViewBatch, wkb);
    case Type.Utf8View:
      return wrap(Utf8ViewBatch, wkt);
    case Type.List:
      return ListBatch;
    case Type.LargeList:
      return LargeListBatch;
    case Type.Map:
      return useMap ? MapBatch : MapEntryBatch;
    case Type.ListView:
      return ListViewBatch;
    case Type.LargeListView:
      return LargeListViewBatch;
    case Type.FixedSizeList:
      return FixedListBatch;
    case Type.Struct:
      return useProxy ? StructProxyBatch : StructBatch;
    case Type.RunEndEncoded:
      return RunEndEncodedBatch;
    case Type.Dictionary:
      return DictionaryBatch;
    case Type.Union:
      return mode ? DenseUnionBatch : SparseUnionBatch;
  }
  throw new Error(invalidDataType(typeId));
}
function wrap(BaseClass, WrapperClass) {
  return WrapperClass ? class WrapBatch extends WrapperClass {
    constructor(options) {
      super(new BaseClass(options));
    }
  } : BaseClass;
}
// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/encode/builder.js
function writeInt32(buf, index, value) {
  buf[index] = value;
  buf[index + 1] = value >> 8;
  buf[index + 2] = value >> 16;
  buf[index + 3] = value >> 24;
}
function writeInt64(buf, index, value) {
  const v = BigInt(value);
  writeInt32(buf, index + 4, Number(BigInt.asIntN(32, v >> BigInt(32))));
  writeInt32(buf, index + 0, Number(BigInt.asIntN(32, v)));
}
var INIT_SIZE = 1024;

class Builder {
  constructor(sink) {
    this.sink = sink;
    this.minalign = 1;
    this.buf = new Uint8Array(INIT_SIZE);
    this.space = INIT_SIZE;
    this.vtables = [];
    this.outputBytes = 0;
  }
  offset() {
    return this.buf.length - this.space;
  }
  writeInt8(value) {
    this.buf[this.space -= 1] = value;
  }
  writeInt16(value) {
    this.buf[this.space -= 2] = value;
    this.buf[this.space + 1] = value >> 8;
  }
  writeInt32(value) {
    writeInt32(this.buf, this.space -= 4, value);
  }
  writeInt64(value) {
    writeInt64(this.buf, this.space -= 8, value);
  }
  addInt8(value) {
    prep(this, 1, 0);
    this.writeInt8(value);
  }
  addInt16(value) {
    prep(this, 2, 0);
    this.writeInt16(value);
  }
  addInt32(value) {
    prep(this, 4, 0);
    this.writeInt32(value);
  }
  addInt64(value) {
    prep(this, 8, 0);
    this.writeInt64(value);
  }
  addOffset(offset) {
    prep(this, SIZEOF_INT, 0);
    this.writeInt32(this.offset() - offset + SIZEOF_INT);
  }
  addObject(numFields, addFields) {
    const b = objectBuilder(this, numFields);
    addFields?.(b);
    return b.finish();
  }
  addVector(items, itemSize, alignment, writeItem) {
    const n = items?.length;
    if (!n)
      return 0;
    prep(this, SIZEOF_INT, itemSize * n);
    prep(this, alignment, itemSize * n);
    for (let i = n;--i >= 0; ) {
      writeItem(this, items[i]);
    }
    this.writeInt32(n);
    return this.offset();
  }
  addOffsetVector(offsets) {
    return this.addVector(offsets, 4, 4, (b, off) => b.addOffset(off));
  }
  addString(s) {
    if (s == null)
      return 0;
    const utf8 = encodeUtf8(s);
    const n = utf8.length;
    this.addInt8(0);
    prep(this, SIZEOF_INT, n);
    this.buf.set(utf8, this.space -= n);
    this.writeInt32(n);
    return this.offset();
  }
  finish(rootOffset) {
    prep(this, this.minalign, SIZEOF_INT);
    this.addOffset(rootOffset);
  }
  flush() {
    const { buf, sink } = this;
    const bytes = buf.subarray(this.space, buf.length);
    sink.write(bytes);
    this.outputBytes += bytes.byteLength;
    this.minalign = 1;
    this.vtables = [];
    this.buf = new Uint8Array(INIT_SIZE);
    this.space = INIT_SIZE;
  }
  addBuffer(buffer) {
    const size = buffer.byteLength;
    if (!size)
      return 0;
    this.sink.write(buffer);
    this.outputBytes += size;
    const pad = (size + 7 & ~7) - size;
    this.addPadding(pad);
    return size + pad;
  }
  addPadding(byteCount) {
    if (byteCount > 0) {
      this.sink.write(new Uint8Array(byteCount));
      this.outputBytes += byteCount;
    }
  }
}
function prep(builder, size, additionalBytes) {
  let { buf, space, minalign } = builder;
  if (size > minalign) {
    builder.minalign = size;
  }
  const bufSize = buf.length;
  const used = bufSize - space + additionalBytes;
  const alignSize = ~used + 1 & size - 1;
  buf = grow(buf, used + alignSize + size - 1, true);
  space += buf.length - bufSize;
  for (let i = 0;i < alignSize; ++i) {
    buf[--space] = 0;
  }
  builder.buf = buf;
  builder.space = space;
}
function objectBuilder(builder, numFields) {
  const vtable = Array(numFields).fill(0);
  const startOffset = builder.offset();
  function slot(index) {
    vtable[index] = builder.offset();
  }
  return {
    addInt8(index, value, defaultValue) {
      if (value != defaultValue) {
        builder.addInt8(value);
        slot(index);
      }
    },
    addInt16(index, value, defaultValue) {
      if (value != defaultValue) {
        builder.addInt16(value);
        slot(index);
      }
    },
    addInt32(index, value, defaultValue) {
      if (value != defaultValue) {
        builder.addInt32(value);
        slot(index);
      }
    },
    addInt64(index, value, defaultValue) {
      if (value != defaultValue) {
        builder.addInt64(value);
        slot(index);
      }
    },
    addOffset(index, value, defaultValue) {
      if (value != defaultValue) {
        builder.addOffset(value);
        slot(index);
      }
    },
    finish() {
      builder.addInt32(0);
      const vtableOffset = builder.offset();
      let i = numFields;
      while (--i >= 0 && vtable[i] === 0) {}
      const size = i + 1;
      for (;i >= 0; --i) {
        builder.addInt16(vtable[i] ? vtableOffset - vtable[i] : 0);
      }
      const standardFields = 2;
      builder.addInt16(vtableOffset - startOffset);
      const len = (size + standardFields) * SIZEOF_SHORT;
      builder.addInt16(len);
      let existingTable = 0;
      const { buf, vtables, space: vt1 } = builder;
      outer_loop:
        for (i = 0;i < vtables.length; ++i) {
          const vt2 = buf.length - vtables[i];
          if (len == readInt16(buf, vt2)) {
            for (let j = SIZEOF_SHORT;j < len; j += SIZEOF_SHORT) {
              if (readInt16(buf, vt1 + j) != readInt16(buf, vt2 + j)) {
                continue outer_loop;
              }
            }
            existingTable = vtables[i];
            break;
          }
        }
      if (existingTable) {
        builder.space = buf.length - vtableOffset;
        writeInt32(buf, builder.space, existingTable - vtableOffset);
      } else {
        const off = builder.offset();
        vtables.push(off);
        writeInt32(buf, buf.length - vtableOffset, off - vtableOffset);
      }
      return vtableOffset;
    }
  };
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/compression.js
var LENGTH_NO_COMPRESSED_DATA = -1;
var COMPRESS_LENGTH_PREFIX = 8;
function missingCodec(type) {
  return `Missing compression codec "${keyFor(CompressionType, type)}" (id ${type})`;
}
var codecs = new Map;
function getCompressionCodec(type) {
  return type != null && codecs.get(type) || null;
}
function decompressBuffer(body, { offset, length }, codec) {
  if (length === 0) {
    return { bytes: new Uint8Array(0), offset: 0, length: 0 };
  }
  const ulen = readInt64(body, offset);
  const buf = body.subarray(offset + COMPRESS_LENGTH_PREFIX, offset + length);
  const bytes = ulen === LENGTH_NO_COMPRESSED_DATA ? buf : codec.decode(buf, ulen);
  return { bytes, offset: 0, length: bytes.length };
}
function compressBuffer(bytes, codec) {
  const compressed = codec.encode(bytes);
  const keep = compressed.length < bytes.length;
  const data = keep ? compressed : bytes;
  const buf = new Uint8Array(COMPRESS_LENGTH_PREFIX + data.length);
  writeInt64(buf, 0, keep ? bytes.length : LENGTH_NO_COMPRESSED_DATA);
  buf.set(data, COMPRESS_LENGTH_PREFIX);
  return buf;
}
// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/decode/block.js
function decodeBlock(buf, index) {
  return {
    offset: readInt64(buf, index),
    metadataLength: readInt32(buf, index + 8),
    bodyLength: readInt64(buf, index + 16)
  };
}
function decodeBlocks(buf, index) {
  return readVector(buf, index, 24, decodeBlock);
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/decode/body-compression.js
function decodeBodyCompression(buf, index) {
  const get = readObject(buf, index);
  return {
    codec: get(4, readInt8, CompressionType.LZ4_FRAME),
    method: get(6, readInt8, BodyCompressionMethod.BUFFER)
  };
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/decode/record-batch.js
function decodeRecordBatch(buf, index, version) {
  const get = readObject(buf, index);
  const offset = version < Version.V4 ? 8 : 0;
  return {
    length: get(4, readInt64, 0),
    nodes: readVector(buf, get(6, readOffset), 16, (buf, pos) => ({
      length: readInt64(buf, pos),
      nullCount: readInt64(buf, pos + 8)
    })),
    regions: readVector(buf, get(8, readOffset), 16 + offset, (buf, pos) => ({
      offset: readInt64(buf, pos + offset),
      length: readInt64(buf, pos + offset + 8)
    })),
    compression: get(10, decodeBodyCompression),
    variadic: readVector(buf, get(12, readOffset), 8, readInt64)
  };
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/decode/dictionary-batch.js
function decodeDictionaryBatch(buf, index, version) {
  const get = readObject(buf, index);
  return {
    id: get(4, readInt64, 0),
    data: get(6, (buf, off) => decodeRecordBatch(buf, off, version)),
    isDelta: get(8, readBoolean, false)
  };
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/decode/data-type.js
function decodeDataType(buf, index, typeId, children) {
  checkOneOf(typeId, Type, invalidDataType);
  const get = readObject(buf, index);
  switch (typeId) {
    case Type.Binary:
      return binary();
    case Type.Utf8:
      return utf8();
    case Type.LargeBinary:
      return largeBinary();
    case Type.LargeUtf8:
      return largeUtf8();
    case Type.List:
      return list(children[0]);
    case Type.ListView:
      return listView(children[0]);
    case Type.LargeList:
      return largeList(children[0]);
    case Type.LargeListView:
      return largeListView(children[0]);
    case Type.Struct:
      return struct(children);
    case Type.RunEndEncoded:
      return runEndEncoded(children[0], children[1]);
    case Type.Int:
      return int(get(4, readInt32, 0), get(6, readBoolean, false));
    case Type.Float:
      return float(get(4, readInt16, Precision.HALF));
    case Type.Decimal:
      return decimal(get(4, readInt32, 0), get(6, readInt32, 0), get(8, readInt32, 128));
    case Type.Date:
      return date(get(4, readInt16, DateUnit.MILLISECOND));
    case Type.Time:
      return time(get(4, readInt16, TimeUnit.MILLISECOND));
    case Type.Timestamp:
      return timestamp(get(4, readInt16, TimeUnit.SECOND), get(6, readString));
    case Type.Interval:
      return interval(get(4, readInt16, IntervalUnit.YEAR_MONTH));
    case Type.Duration:
      return duration(get(4, readInt16, TimeUnit.MILLISECOND));
    case Type.FixedSizeBinary:
      return fixedSizeBinary(get(4, readInt32, 0));
    case Type.FixedSizeList:
      return fixedSizeList(children[0], get(4, readInt32, 0));
    case Type.Map:
      return mapType(get(4, readBoolean, false), children[0]);
    case Type.Union:
      return union(get(4, readInt16, UnionMode.Sparse), children, readVector(buf, get(6, readOffset), 4, readInt32));
  }
  return { typeId };
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/decode/metadata.js
function decodeMetadata(buf, index) {
  const entries = readVector(buf, index, 4, (buf, pos) => {
    const get = readObject(buf, pos);
    return [
      get(4, readString),
      get(6, readString)
    ];
  });
  return entries.length ? new Map(entries) : null;
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/decode/schema.js
function decodeSchema(buf, index, version) {
  const get = readObject(buf, index);
  return {
    version,
    endianness: get(4, readInt16, 0),
    fields: get(6, decodeSchemaFields, []),
    metadata: get(8, decodeMetadata)
  };
}
function decodeSchemaFields(buf, fieldsOffset) {
  return readVector(buf, fieldsOffset, 4, decodeField);
}
function decodeField(buf, index) {
  const get = readObject(buf, index);
  const typeId = get(8, readUint8, Type.NONE);
  const typeOffset = get(10, readOffset, 0);
  const dict = get(12, decodeDictionary);
  const children = get(14, decodeFieldChildren, []);
  let type = decodeDataType(buf, typeOffset, typeId, children);
  if (dict) {
    dict.dictionary = type;
    type = dict;
  }
  return {
    name: get(4, readString),
    type,
    nullable: get(6, readBoolean, false),
    metadata: get(16, decodeMetadata)
  };
}
function decodeFieldChildren(buf, fieldOffset) {
  return readVector(buf, fieldOffset, 4, decodeField);
}
function decodeDictionary(buf, index) {
  if (!index)
    return null;
  const get = readObject(buf, index);
  return dictionary(null, get(6, decodeInt, int32()), get(8, readBoolean, false), get(4, readInt64, 0));
}
function decodeInt(buf, index) {
  return decodeDataType(buf, index, Type.Int);
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/decode/message.js
var invalidMessageMetadata = (expected, actual) => `Expected to read ${expected} metadata bytes, but only read ${actual}.`;
var invalidMessageBodyLength = (expected, actual) => `Expected to read ${expected} bytes for message body, but only read ${actual}.`;
var invalidMessageType = (type) => `Unsupported message type: ${type} (${keyFor(MessageHeader, type)})`;
function decodeMessage(buf, index) {
  let metadataLength = readInt32(buf, index) || 0;
  index += SIZEOF_INT;
  if (metadataLength === -1) {
    metadataLength = readInt32(buf, index) || 0;
    index += SIZEOF_INT;
  }
  if (metadataLength === 0)
    return null;
  const head = buf.subarray(index, index += metadataLength);
  if (head.byteLength < metadataLength) {
    throw new Error(invalidMessageMetadata(metadataLength, head.byteLength));
  }
  const get = readObject(head, 0);
  const version = get(4, readInt16, Version.V1);
  const type = get(6, readUint8, MessageHeader.NONE);
  const offset = get(8, readOffset, 0);
  const bodyLength = get(10, readInt64, 0);
  let content;
  if (offset) {
    const decoder = type === MessageHeader.Schema ? decodeSchema : type === MessageHeader.DictionaryBatch ? decodeDictionaryBatch : type === MessageHeader.RecordBatch ? decodeRecordBatch : null;
    if (!decoder)
      throw new Error(invalidMessageType(type));
    content = decoder(head, offset, version);
    if (bodyLength > 0) {
      const body = buf.subarray(index, index += bodyLength);
      if (body.byteLength < bodyLength) {
        throw new Error(invalidMessageBodyLength(bodyLength, body.byteLength));
      }
      content.body = body;
    } else if (type !== MessageHeader.Schema) {
      content.body = new Uint8Array(0);
    }
  }
  return { version, type, index, content };
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/decode/decode-ipc.js
function decodeIPC(data) {
  const source = isArrayBufferLike(data) ? new Uint8Array(data) : data;
  return isUint8Array(source) && isArrowFileFormat(source) ? decodeIPCFile(source) : decodeIPCStream(source);
}
function isArrowFileFormat(buf) {
  if (!buf || buf.length < 4)
    return false;
  for (let i = 0;i < 6; ++i) {
    if (MAGIC[i] !== buf[i])
      return false;
  }
  return true;
}
function decodeIPCStream(data) {
  const stream = [data].flat();
  let schema;
  const records = [];
  const dictionaries = [];
  const dictsBeforeRecord = [];
  for (const buf of stream) {
    if (!isUint8Array(buf)) {
      throw new Error(`IPC data batch was not a Uint8Array.`);
    }
    let offset = 0;
    while (true) {
      const m = decodeMessage(buf, offset);
      if (m === null)
        break;
      offset = m.index;
      if (!m.content)
        continue;
      switch (m.type) {
        case MessageHeader.Schema:
          if (!schema)
            schema = m.content;
          break;
        case MessageHeader.RecordBatch:
          records.push(m.content);
          dictsBeforeRecord.push(dictionaries.length);
          break;
        case MessageHeader.DictionaryBatch:
          dictionaries.push(m.content);
          break;
      }
    }
  }
  return { schema, dictionaries, records, dictsBeforeRecord, metadata: null };
}
function decodeIPCFile(data) {
  const offset = data.byteLength - (MAGIC.length + 4);
  const length = readInt32(data, offset);
  const get = readObject(data, offset - length);
  const version = get(4, readInt16, Version.V1);
  const dicts = get(8, decodeBlocks, []);
  const recs = get(10, decodeBlocks, []);
  const dictsBeforeRecord = recs.map((rec) => dicts.filter((d) => d.offset < rec.offset).length);
  return {
    schema: get(6, (buf, index) => decodeSchema(buf, index, version)),
    dictionaries: dicts.map(({ offset }) => decodeMessage(data, offset).content),
    records: recs.map(({ offset }) => decodeMessage(data, offset).content),
    dictsBeforeRecord,
    metadata: get(12, decodeMetadata)
  };
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/decode/table-from-ipc.js
function tableFromIPC(data, options) {
  return createTable(decodeIPC(data), options);
}
function createTable(data, options = {}) {
  const { schema = { fields: [] }, dictionaries, records, dictsBeforeRecord } = data;
  const { version, fields } = schema;
  const dictionaryMap = new Map;
  const context = contextGenerator(options, version, dictionaryMap);
  const dictionaryTypes = new Map;
  visitSchemaFields(schema, (field) => {
    const type = field.type;
    if (type.typeId === Type.Dictionary) {
      dictionaryTypes.set(type.id, type.dictionary);
    }
  });
  const processDict = (dict) => {
    const { id, data: dictData, isDelta, body } = dict;
    const type = dictionaryTypes.get(id);
    const batch = visit(type, context({ ...dictData, body }));
    const existing = dictionaryMap.get(id);
    if (!existing) {
      if (isDelta) {
        throw new Error("Delta update can not be first dictionary batch.");
      }
      dictionaryMap.set(id, new Column([batch], type));
    } else if (isDelta) {
      dictionaryMap.set(id, new Column([...existing.data, batch], type));
    } else {
      dictionaryMap.set(id, new Column([batch], type));
    }
  };
  const cols = fields.map((f) => columnBuilder(f.type));
  let dictIdx = 0;
  for (let i = 0;i < records.length; i++) {
    const target = dictsBeforeRecord ? dictsBeforeRecord[i] : dictionaries.length;
    while (dictIdx < target) {
      processDict(dictionaries[dictIdx++]);
    }
    const ctx = context(records[i]);
    fields.forEach((f, idx) => cols[idx].add(visit(f.type, ctx, f.metadata)));
  }
  while (dictIdx < dictionaries.length) {
    processDict(dictionaries[dictIdx++]);
  }
  return new Table(schema, cols.map((c) => c.done()), options.useProxy);
}
function visitSchemaFields(schema, visitor) {
  schema.fields.forEach(function visitField(field) {
    visitor(field);
    field.type.dictionary?.children?.forEach(visitField);
    field.type.children?.forEach(visitField);
  });
}
function contextGenerator(options, version, dictionaryMap) {
  const base = {
    version,
    options,
    dictionary: (id) => dictionaryMap.get(id)
  };
  return (batch) => {
    const { length, nodes, regions, compression, variadic, body } = batch;
    let nodeIndex = -1;
    let bufferIndex = -1;
    let variadicIndex = -1;
    return {
      ...base,
      length,
      node: () => nodes[++nodeIndex],
      buffer: (ArrayType) => {
        const { bytes, length, offset } = maybeDecompress(body, regions[++bufferIndex], compression);
        return ArrayType ? new ArrayType(bytes.buffer, bytes.byteOffset + offset, length / ArrayType.BYTES_PER_ELEMENT) : bytes.subarray(offset, offset + length);
      },
      variadic: () => variadic[++variadicIndex],
      visit(children) {
        return children.map((f) => visit(f.type, this, f.metadata));
      }
    };
  };
}
function maybeDecompress(body, region, compression) {
  if (!compression) {
    return { bytes: body, ...region };
  } else if (compression.method !== BodyCompressionMethod.BUFFER) {
    throw new Error(`Unknown compression method (${compression.method})`);
  } else {
    const id = compression.codec;
    const codec = getCompressionCodec(id);
    if (!codec)
      throw new Error(missingCodec(id));
    return decompressBuffer(body, region, codec);
  }
}
function visit(type, ctx, metadata = null) {
  const { typeId } = type;
  const { options, node, buffer, variadic, version } = ctx;
  const BatchType = batchType(type, options, metadata);
  const base = { ...node(), type };
  if (typeId === Type.Null) {
    return new BatchType({ ...base, nullCount: base.length });
  }
  switch (typeId) {
    case Type.Bool:
    case Type.Int:
    case Type.Time:
    case Type.Duration:
    case Type.Float:
    case Type.Decimal:
    case Type.Date:
    case Type.Timestamp:
    case Type.Interval:
    case Type.FixedSizeBinary:
      return new BatchType({
        ...base,
        validity: buffer(),
        values: buffer(type.values)
      });
    case Type.Utf8:
    case Type.LargeUtf8:
    case Type.Binary:
    case Type.LargeBinary:
      return new BatchType({
        ...base,
        validity: buffer(),
        offsets: buffer(type.offsets),
        values: buffer()
      });
    case Type.BinaryView:
    case Type.Utf8View:
      return new BatchType({
        ...base,
        validity: buffer(),
        values: buffer(),
        data: Array.from({ length: variadic() }, () => buffer())
      });
    case Type.List:
    case Type.LargeList:
    case Type.Map:
      return new BatchType({
        ...base,
        validity: buffer(),
        offsets: buffer(type.offsets),
        children: ctx.visit(type.children)
      });
    case Type.ListView:
    case Type.LargeListView:
      return new BatchType({
        ...base,
        validity: buffer(),
        offsets: buffer(type.offsets),
        sizes: buffer(type.offsets),
        children: ctx.visit(type.children)
      });
    case Type.FixedSizeList:
    case Type.Struct:
      return new BatchType({
        ...base,
        validity: buffer(),
        children: ctx.visit(type.children)
      });
    case Type.RunEndEncoded:
      return new BatchType({
        ...base,
        children: ctx.visit(type.children)
      });
    case Type.Dictionary: {
      const { id, indices } = type;
      return new BatchType({
        ...base,
        validity: buffer(),
        values: buffer(indices.values)
      }).setDictionary(ctx.dictionary(id));
    }
    case Type.Union: {
      if (version < Version.V5) {
        buffer();
      }
      return new BatchType({
        ...base,
        typeIds: buffer(int8Array),
        offsets: type.mode === UnionMode.Sparse ? null : buffer(type.offsets),
        children: ctx.visit(type.children)
      });
    }
    default:
      throw new Error(invalidDataType(typeId));
  }
}
// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/encode/record-batch.js
function encodeRecordBatch(builder, batch, compression) {
  const { nodes, regions, variadic } = batch;
  const nodeVector = builder.addVector(nodes, 16, 8, (builder, node) => {
    builder.writeInt64(node.nullCount);
    builder.writeInt64(node.length);
    return builder.offset();
  });
  const regionVector = builder.addVector(regions, 16, 8, (builder, region) => {
    builder.writeInt64(region.length);
    builder.writeInt64(region.offset);
    return builder.offset();
  });
  const variadicVector = builder.addVector(variadic, 8, 8, (builder, count) => builder.addInt64(count));
  return builder.addObject(5, (b) => {
    b.addInt64(0, nodes[0].length, 0);
    b.addOffset(1, nodeVector, 0);
    b.addOffset(2, regionVector, 0);
    b.addOffset(3, encodeCompression(builder, compression), 0);
    b.addOffset(4, variadicVector, 0);
  });
}
function encodeCompression(builder, compression) {
  if (!compression)
    return 0;
  const { codec, method } = compression;
  return builder.addObject(2, (b) => {
    b.addInt8(0, codec, CompressionType.LZ4_FRAME);
    b.addInt8(1, method, BodyCompressionMethod.BUFFER);
  });
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/encode/dictionary-batch.js
function encodeDictionaryBatch(builder, dictionaryBatch, compression) {
  const dataOffset = encodeRecordBatch(builder, dictionaryBatch.data, compression);
  return builder.addObject(3, (b) => {
    b.addInt64(0, dictionaryBatch.id, 0);
    b.addOffset(1, dataOffset, 0);
    b.addInt8(2, +dictionaryBatch.isDelta, 0);
  });
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/encode/metadata.js
function encodeMetadata(builder, metadata) {
  return metadata?.size > 0 ? builder.addOffsetVector(Array.from(metadata, ([k, v]) => {
    const key = builder.addString(`${k}`);
    const val = builder.addString(`${v}`);
    return builder.addObject(2, (b) => {
      b.addOffset(0, key, 0);
      b.addOffset(1, val, 0);
    });
  })) : 0;
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/encode/data-type.js
function encodeDataType(builder, type) {
  const typeId = checkOneOf(type.typeId, Type, invalidDataType);
  switch (typeId) {
    case Type.Dictionary:
      return encodeDictionary(builder, type);
    case Type.Int:
      return encodeInt(builder, type);
    case Type.Float:
      return encodeFloat(builder, type);
    case Type.Decimal:
      return encodeDecimal(builder, type);
    case Type.Date:
      return encodeDate(builder, type);
    case Type.Time:
      return encodeTime(builder, type);
    case Type.Timestamp:
      return encodeTimestamp(builder, type);
    case Type.Interval:
      return encodeInterval(builder, type);
    case Type.Duration:
      return encodeDuration(builder, type);
    case Type.FixedSizeBinary:
    case Type.FixedSizeList:
      return encodeFixedSize(builder, type);
    case Type.Map:
      return encodeMap(builder, type);
    case Type.Union:
      return encodeUnion(builder, type);
  }
  return builder.addObject(0);
}
function encodeDate(builder, type) {
  return builder.addObject(1, (b) => {
    b.addInt16(0, type.unit, DateUnit.MILLISECOND);
  });
}
function encodeDecimal(builder, type) {
  return builder.addObject(3, (b) => {
    b.addInt32(0, type.precision, 0);
    b.addInt32(1, type.scale, 0);
    b.addInt32(2, type.bitWidth, 128);
  });
}
function encodeDuration(builder, type) {
  return builder.addObject(1, (b) => {
    b.addInt16(0, type.unit, TimeUnit.MILLISECOND);
  });
}
function encodeFixedSize(builder, type) {
  return builder.addObject(1, (b) => {
    b.addInt32(0, type.stride, 0);
  });
}
function encodeFloat(builder, type) {
  return builder.addObject(1, (b) => {
    b.addInt16(0, type.precision, Precision.HALF);
  });
}
function encodeInt(builder, type) {
  return builder.addObject(2, (b) => {
    b.addInt32(0, type.bitWidth, 0);
    b.addInt8(1, +type.signed, 0);
  });
}
function encodeInterval(builder, type) {
  return builder.addObject(1, (b) => {
    b.addInt16(0, type.unit, IntervalUnit.YEAR_MONTH);
  });
}
function encodeMap(builder, type) {
  return builder.addObject(1, (b) => {
    b.addInt8(0, +type.keysSorted, 0);
  });
}
function encodeTime(builder, type) {
  return builder.addObject(2, (b) => {
    b.addInt16(0, type.unit, TimeUnit.MILLISECOND);
    b.addInt32(1, type.bitWidth, 32);
  });
}
function encodeTimestamp(builder, type) {
  const timezoneOffset = builder.addString(type.timezone);
  return builder.addObject(2, (b) => {
    b.addInt16(0, type.unit, TimeUnit.SECOND);
    b.addOffset(1, timezoneOffset, 0);
  });
}
function encodeUnion(builder, type) {
  const typeIdsOffset = builder.addVector(type.typeIds, 4, 4, (builder, value) => builder.addInt32(value));
  return builder.addObject(2, (b) => {
    b.addInt16(0, type.mode, UnionMode.Sparse);
    b.addOffset(1, typeIdsOffset, 0);
  });
}
function encodeDictionary(builder, type) {
  return builder.addObject(4, (b) => {
    b.addInt64(0, type.id, 0);
    b.addOffset(1, encodeDataType(builder, type.indices), 0);
    b.addInt8(2, +type.ordered, 0);
  });
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/encode/schema.js
var isLittleEndian = new Uint16Array(new Uint8Array([1, 0]).buffer)[0] === 1;
function encodeSchema(builder, schema) {
  const { fields, metadata } = schema;
  const fieldOffsets = fields.map((f) => encodeField(builder, f));
  const fieldsVectorOffset = builder.addOffsetVector(fieldOffsets);
  const metadataOffset = encodeMetadata(builder, metadata);
  return builder.addObject(4, (b) => {
    b.addInt16(0, +!isLittleEndian, 0);
    b.addOffset(1, fieldsVectorOffset, 0);
    b.addOffset(2, metadataOffset, 0);
  });
}
function encodeField(builder, field) {
  const { name, nullable, type, metadata } = field;
  let { typeId } = type;
  let typeOffset = 0;
  let dictionaryOffset = 0;
  if (typeId !== Type.Dictionary) {
    typeOffset = encodeDataType(builder, type);
  } else {
    const dict = type.dictionary;
    typeId = dict.typeId;
    dictionaryOffset = encodeDataType(builder, type);
    typeOffset = encodeDataType(builder, dict);
  }
  const childOffsets = (type.children || []).map((f) => encodeField(builder, f));
  const childrenVectorOffset = builder.addOffsetVector(childOffsets);
  const metadataOffset = encodeMetadata(builder, metadata);
  const nameOffset = builder.addString(name);
  return builder.addObject(7, (b) => {
    b.addOffset(0, nameOffset, 0);
    b.addInt8(1, +nullable, 0);
    b.addInt8(2, typeId, Type.NONE);
    b.addOffset(3, typeOffset, 0);
    b.addOffset(4, dictionaryOffset, 0);
    b.addOffset(5, childrenVectorOffset, 0);
    b.addOffset(6, metadataOffset, 0);
  });
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/encode/footer.js
function writeFooter(builder, schema, dictBlocks, recordBlocks, metadata) {
  const metadataOffset = encodeMetadata(builder, metadata);
  const recsOffset = builder.addVector(recordBlocks, 24, 8, encodeBlock);
  const dictsOffset = builder.addVector(dictBlocks, 24, 8, encodeBlock);
  const schemaOffset = encodeSchema(builder, schema);
  builder.finish(builder.addObject(5, (b) => {
    b.addInt16(0, Version.V5, Version.V1);
    b.addOffset(1, schemaOffset, 0);
    b.addOffset(2, dictsOffset, 0);
    b.addOffset(3, recsOffset, 0);
    b.addOffset(4, metadataOffset, 0);
  }));
  const size = builder.offset();
  builder.addInt32(0);
  builder.addInt32(-1);
  builder.flush();
  builder.sink.write(new Uint8Array(Int32Array.of(size).buffer));
  builder.sink.write(MAGIC);
}
function encodeBlock(builder, { offset, metadataLength, bodyLength }) {
  builder.writeInt64(bodyLength);
  builder.writeInt32(0);
  builder.writeInt32(metadataLength);
  builder.writeInt64(offset);
  return builder.offset();
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/encode/message.js
function writeMessage(builder, headerType, headerOffset, bodyLength, blocks) {
  builder.finish(builder.addObject(5, (b) => {
    b.addInt16(0, Version.V5, Version.V1);
    b.addInt8(1, headerType, MessageHeader.NONE);
    b.addOffset(2, headerOffset, 0);
    b.addInt64(3, bodyLength, 0);
  }));
  const prefixSize = 8;
  const messageSize = builder.offset();
  const alignedSize = messageSize + prefixSize + 7 & ~7;
  blocks?.push({
    offset: builder.outputBytes,
    metadataLength: alignedSize,
    bodyLength
  });
  builder.addInt32(alignedSize - prefixSize);
  builder.addInt32(-1);
  builder.flush();
  builder.addPadding(alignedSize - messageSize - prefixSize);
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/encode/sink.js
class Sink {
  write(bytes) {}
  pad(byteCount) {
    this.write(new Uint8Array(byteCount));
  }
  finish() {
    return null;
  }
}

class MemorySink extends Sink {
  constructor() {
    super();
    this.buffers = [];
  }
  write(bytes) {
    this.buffers.push(bytes);
  }
  finish() {
    const bufs = this.buffers;
    const size = bufs.reduce((sum, b) => sum + b.byteLength, 0);
    const buf = new Uint8Array(size);
    for (let i = 0, off = 0;i < bufs.length; ++i) {
      buf.set(bufs[i], off);
      off += bufs[i].byteLength;
    }
    return buf;
  }
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/encode/encode-ipc.js
var STREAM = "stream";
var FILE = "file";
function encodeIPC(data, { sink, format = STREAM, codec } = {}) {
  if (format !== STREAM && format !== FILE) {
    throw new Error(`Unrecognized Arrow IPC format: ${format}`);
  }
  const { schema, dictionaries = [], records = [], metadata } = data;
  const builder = new Builder(sink || new MemorySink);
  const file = format === FILE;
  const dictBlocks = [];
  const recordBlocks = [];
  const compression = codec != null ? { codec, method: BodyCompressionMethod.BUFFER } : null;
  if (file) {
    builder.addBuffer(MAGIC);
  }
  if (schema) {
    writeMessage(builder, MessageHeader.Schema, encodeSchema(builder, schema), 0);
  }
  for (const dict of dictionaries) {
    const { data } = dict;
    writeMessage(builder, MessageHeader.DictionaryBatch, encodeDictionaryBatch(builder, dict, compression), data.byteLength, dictBlocks);
    writeBuffers(builder, data.buffers);
  }
  for (const batch of records) {
    writeMessage(builder, MessageHeader.RecordBatch, encodeRecordBatch(builder, batch, compression), batch.byteLength, recordBlocks);
    writeBuffers(builder, batch.buffers);
  }
  builder.addBuffer(EOS);
  if (file) {
    writeFooter(builder, schema, dictBlocks, recordBlocks, metadata);
  }
  return builder.sink;
}
function writeBuffers(builder, buffers) {
  for (let i = 0;i < buffers.length; ++i) {
    builder.addBuffer(buffers[i]);
  }
}

// ../../node_modules/.bun/@uwdata+flechette@2.7.0/node_modules/@uwdata/flechette/src/encode/table-to-ipc.js
function tableToIPC(table, options) {
  if (typeof options === "string") {
    options = { format: options };
  }
  const id = options?.codec;
  const codec = getCompressionCodec(id);
  if (id != null && !codec)
    throw new Error(missingCodec(id));
  const columns = table.children;
  checkBatchLengths(columns);
  const { dictionaries, idMap } = assembleDictionaryBatches(columns, codec);
  const records = assembleRecordBatches(columns, codec);
  const schema = assembleSchema(table.schema, idMap);
  const data = { schema, dictionaries, records };
  return encodeIPC(data, { ...options, codec: id }).finish();
}
function checkBatchLengths(columns) {
  const n = columns[0]?.data.map((d) => d.length);
  columns.forEach(({ data }) => {
    if (data.length !== n.length || data.some((b, i) => b.length !== n[i])) {
      throw new Error("Columns have inconsistent batch sizes.");
    }
  });
}
function assembleContext(codec) {
  let byteLength = 0;
  const nodes = [];
  const regions = [];
  const buffers = [];
  const variadic = [];
  return {
    node(length, nullCount) {
      nodes.push({ length, nullCount });
    },
    buffer(b) {
      const bytes = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      const buf = codec ? compressBuffer(bytes, codec) : bytes;
      const length = buf.byteLength;
      regions.push({ offset: byteLength, length });
      buffers.push(buf);
      byteLength += length + 7 & ~7;
    },
    variadic(length) {
      variadic.push(length);
    },
    children(type, batch) {
      type.children.forEach((field, index) => {
        visit2(field.type, batch.children[index], this);
      });
    },
    done() {
      return { byteLength, nodes, regions, variadic, buffers };
    }
  };
}
function assembleDictionaryBatches(columns, codec) {
  const dictionaries = [];
  const dictMap = new Map;
  const idMap = new Map;
  let id = -1;
  const visitor = (dictionaryColumn) => {
    if (!dictMap.has(dictionaryColumn)) {
      dictMap.set(dictionaryColumn, ++id);
      for (let i = 0;i < dictionaryColumn.data.length; ++i) {
        dictionaries.push({
          id,
          isDelta: i > 0,
          data: assembleRecordBatch([dictionaryColumn], i, codec)
        });
      }
      idMap.set(dictionaryColumn.type, id);
    } else {
      idMap.set(dictionaryColumn.type, dictMap.get(dictionaryColumn));
    }
  };
  columns.forEach((col) => visitDictionaries(col.data[0], visitor));
  return { dictionaries, idMap };
}
function visitDictionaries(batch, visitor) {
  if (batch?.type.typeId === Type.Dictionary) {
    const dictionary = batch.dictionary;
    visitor(dictionary);
    visitDictionaries(dictionary.data[0], visitor);
  }
  batch?.children?.forEach((child) => visitDictionaries(child, visitor));
}
function assembleSchema(schema, idMap) {
  if (!idMap.size)
    return schema;
  const visit = (type) => {
    if (type.typeId === Type.Dictionary) {
      type.id = idMap.get(type.dictionary);
      visitDictType(type);
    }
    if (type.children) {
      (type.children = type.children.slice()).forEach(visitFields);
    }
  };
  const visitFields = (field, index, array) => {
    const type = { ...field.type };
    array[index] = { ...field, type };
    visit(type);
  };
  const visitDictType = (parentType) => {
    const type = { ...parentType.dictionary };
    parentType.dictionary = type;
    visit(type);
  };
  schema = { ...schema, fields: schema.fields.slice() };
  schema.fields.forEach(visitFields);
  return schema;
}
function assembleRecordBatches(columns, codec) {
  return (columns[0]?.data || []).map((_, index) => assembleRecordBatch(columns, index, codec));
}
function assembleRecordBatch(columns, batchIndex = 0, codec) {
  const ctx = assembleContext(codec);
  columns.forEach((column) => {
    visit2(column.type, column.data[batchIndex], ctx);
  });
  return ctx.done();
}
function visit2(type, batch, ctx) {
  const { typeId } = type;
  ctx.node(batch.length, batch.nullCount);
  if (typeId === Type.Null)
    return;
  switch (typeId) {
    case Type.Bool:
    case Type.Int:
    case Type.Time:
    case Type.Duration:
    case Type.Float:
    case Type.Date:
    case Type.Timestamp:
    case Type.Decimal:
    case Type.Interval:
    case Type.FixedSizeBinary:
    case Type.Dictionary:
      ctx.buffer(batch.validity);
      ctx.buffer(batch.values);
      return;
    case Type.Utf8:
    case Type.LargeUtf8:
    case Type.Binary:
    case Type.LargeBinary:
      ctx.buffer(batch.validity);
      ctx.buffer(batch.offsets);
      ctx.buffer(batch.values);
      return;
    case Type.BinaryView:
    case Type.Utf8View:
      ctx.buffer(batch.validity);
      ctx.buffer(batch.values);
      ctx.variadic(batch.data.length);
      batch.data.forEach((b) => ctx.buffer(b));
      return;
    case Type.List:
    case Type.LargeList:
    case Type.Map:
      ctx.buffer(batch.validity);
      ctx.buffer(batch.offsets);
      ctx.children(type, batch);
      return;
    case Type.ListView:
    case Type.LargeListView:
      ctx.buffer(batch.validity);
      ctx.buffer(batch.offsets);
      ctx.buffer(batch.sizes);
      ctx.children(type, batch);
      return;
    case Type.FixedSizeList:
    case Type.Struct:
      ctx.buffer(batch.validity);
      ctx.children(type, batch);
      return;
    case Type.RunEndEncoded:
      ctx.children(type, batch);
      return;
    case Type.Union: {
      ctx.buffer(batch.typeIds);
      if (type.mode === UnionMode.Dense) {
        ctx.buffer(batch.offsets);
      }
      ctx.children(type, batch);
      return;
    }
    default:
      throw new Error(invalidDataType(typeId));
  }
}
// ../../node_modules/.bun/@quack-protocol+sdk@0.3.0/node_modules/@quack-protocol/sdk/dist/index.js
function ct(e, t, n) {
  return {
    kind: "decimal",
    value: yt(e, n),
    width: t,
    scale: n
  };
}
function lt(e) {
  return {
    kind: "date",
    days: e
  };
}
function ut(e) {
  return lt(Math.trunc(Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate()) / 86400000));
}
function ht(e, t = "micros", n) {
  return n === undefined ? {
    kind: "timestamp",
    unit: t,
    value: BigInt(e)
  } : {
    kind: "timestamp",
    unit: t,
    value: BigInt(e),
    timezone: n
  };
}
function gt(e, t = "micros", n) {
  let r = BigInt(e.getTime());
  return ht(t === "seconds" ? r / 1000n : t === "millis" ? r : t === "nanos" ? r * 1000000n : r * 1000n, t, n);
}
function yt(e, n) {
  if (typeof e == "bigint")
    return e;
  let r = String(e).trim(), i = r.startsWith("-"), [a = "0", o = ""] = (i || r.startsWith("+") ? r.slice(1) : r).split(".");
  if (!/^\d+$/.test(a || "0") || !/^\d*$/.test(o))
    throw new u(`Invalid decimal value ${String(e)}`);
  let s = o.padEnd(n, "0").slice(0, n), c = BigInt(`${a || "0"}${s}` || "0");
  return i ? -c : c;
}
function D2(e, t, n) {
  return n ? {
    name: n,
    type: e,
    values: t
  } : {
    type: e,
    values: t
  };
}
function O2(e) {
  if (e.length === 0)
    throw new u("A Quack DataChunk must contain at least one column");
  let n = e[0]?.values.length ?? 0, r = [], i = [], a = [];
  for (let o = 0;o < e.length; o++) {
    let s = e[o];
    if (!s)
      throw new u(`Missing column ${o}`);
    if (s.values.length !== n)
      throw new u(`Column ${o} has ${s.values.length} values, expected ${n}`);
    i.push(s.type), a.push(s.name ?? `column${o}`), r.push({
      type: s.type,
      vectorType: j.FLAT,
      values: [...s.values]
    });
  }
  return {
    rowCount: n,
    types: i,
    columns: r,
    columnNames: a
  };
}
function k2(e, t = {}) {
  return O2(bt(e, t.columns).map((t) => D2(t.type, e.map((e) => j2(e[t.name], t.type)), t.name)));
}
function bt(e, n) {
  if (Array.isArray(n))
    return n.map((e) => ({
      name: e.name,
      type: e.type
    }));
  if (n)
    return Object.entries(n).map(([e, n]) => {
      if (!n)
        throw new u(`Column ${e} is missing a logical type`);
      return {
        name: e,
        type: n
      };
    });
  let r = e[0];
  if (!r)
    throw new u("Cannot infer append row columns from an empty row set");
  return Object.keys(r).map((t) => ({
    name: t,
    type: A2(e.map((e) => e[t]))
  }));
}
function A2(e) {
  let n = e.find((e) => e != null);
  if (n == null)
    throw new u("Cannot infer logical type from only null values");
  if (typeof n == "boolean")
    return oe.boolean();
  if (typeof n == "bigint")
    return oe.bigint();
  if (typeof n == "number")
    return Number.isInteger(n) && n >= -2147483648 && n <= 2147483647 ? oe.integer() : oe.double();
  if (typeof n == "string")
    return oe.varchar();
  if (n instanceof Uint8Array)
    return oe.blob();
  if (n instanceof Date)
    return oe.timestamp();
  if (Array.isArray(n)) {
    let t = e.flatMap((e) => Array.isArray(e) ? e : []);
    return oe.list(A2(t));
  }
  if (wt(n))
    return oe.decimal(n.width, n.scale);
  if (Tt(n))
    return oe.date();
  if (Et(n))
    return n.unit === "nanos" ? oe.timeNs() : oe.time();
  if (Dt(n))
    return oe.timeTz();
  if (Ot(n))
    switch (n.unit) {
      case "seconds":
        return oe.timestampSeconds();
      case "millis":
        return oe.timestampMillis();
      case "nanos":
        return n.timezone === "utc" ? oe.timestampTzNanos() : oe.timestampNanos();
      default:
        return n.timezone === "utc" ? oe.timestampTz() : oe.timestamp();
    }
  if (kt(n))
    return oe.interval();
  if (typeof n == "object")
    return oe.struct(Object.keys(n).map((t) => ({
      name: t,
      type: A2(e.map((e) => e && typeof e == "object" && !Array.isArray(e) && !(e instanceof Uint8Array) ? e[t] : null))
    })));
  throw new u(`Cannot infer logical type for value ${String(n)}`);
}
function j2(e, t) {
  if (e == null)
    return null;
  if (e instanceof Date) {
    if (t.id === v.DATE)
      return ut(e);
    if (xt(t))
      return gt(e, Ct(t), St(t) ? "utc" : undefined);
  }
  if (Array.isArray(e)) {
    let n = t.id === v.LIST || t.id === v.MAP || t.id === v.ARRAY ? E(t) : undefined;
    return n ? e.map((e) => j2(e, n)) : e.map((e) => j2(e, oe.varchar()));
  }
  if (typeof e == "object" && !(e instanceof Uint8Array)) {
    if (t.id === v.STRUCT) {
      let n = D(t), r = e, i = {};
      for (let e of n)
        i[e.name] = j2(r[e.name], e.type);
      return i;
    }
    if (t.id === v.MAP && Array.isArray(e)) {
      let n = E(t);
      return e.map((e) => j2(e, n));
    }
  }
  return e;
}
function xt(e) {
  return e.id === v.TIMESTAMP || e.id === v.TIMESTAMP_SEC || e.id === v.TIMESTAMP_MS || e.id === v.TIMESTAMP_NS || St(e);
}
function St(e) {
  return e.id === v.TIMESTAMP_TZ || e.id === v.TIMESTAMP_TZ_NS;
}
function Ct(e) {
  switch (e.id) {
    case v.TIMESTAMP_SEC:
      return "seconds";
    case v.TIMESTAMP_MS:
      return "millis";
    case v.TIMESTAMP_NS:
    case v.TIMESTAMP_TZ_NS:
      return "nanos";
    default:
      return "micros";
  }
}
function wt(e) {
  return typeof e == "object" && !!e && e.kind === "decimal";
}
function Tt(e) {
  return typeof e == "object" && !!e && e.kind === "date";
}
function Et(e) {
  return typeof e == "object" && !!e && e.kind === "time";
}
function Dt(e) {
  return typeof e == "object" && !!e && e.kind === "time_tz";
}
function Ot(e) {
  return typeof e == "object" && !!e && e.kind === "timestamp";
}
function kt(e) {
  return typeof e == "object" && !!e && e.kind === "interval";
}
var At = new TextEncoder;
var jt = "quack:logicalType";
var Mt = "ARROW:extension:name";
var M2 = "__quackBigInt";
function Nt(e, t = e.columnNames, n = {}) {
  return N2([e], t, n);
}
function N2(e, n, r = {}) {
  let i = r.duckTypes ?? e[0]?.types ?? [], a = ln(n, e[0], i.length);
  if (a.length !== i.length)
    throw new u(`Arrow conversion has ${a.length} column names but ${i.length} DuckDB types`);
  let o = pn(r), s = i.map((e, t) => I2(a[t] ?? `column${t}`, e)), c = s.map((n, r) => {
    let a = i[r];
    if (!a)
      throw new u(`Missing DuckDB type for Arrow column ${r}`);
    return new Column(e.map((e) => {
      if (e.types.length !== i.length || e.columns.length !== i.length)
        throw new u("All Quack chunks converted to Arrow must have the same column count");
      let s = e.columns[r];
      if (!s)
        throw new u(`Chunk is missing column ${r}`);
      return L2(n.type, a, s.values, o, n.metadata);
    }), n.type);
  });
  return new Table({
    version: Version.V5,
    endianness: Endianness.Little,
    fields: s,
    metadata: null
  }, c, r.useProxy);
}
function P2(e, n = {}) {
  let r = tableToIPC(e, {
    ...n.format === undefined ? {} : { format: n.format },
    ...n.codec === undefined ? {} : { codec: n.codec }
  });
  if (!r)
    throw new u("Arrow IPC encoding did not return in-memory bytes");
  return r;
}
function Ft(e, t = {}) {
  return F2(tableFromIPC(e, pn(t)), t);
}
function F2(e, n = {}) {
  if (e.numCols === 0)
    throw new u("Cannot convert an Arrow table with no columns to Quack append chunks");
  let r = e.schema.fields, i = r.map((e, t) => Jt(e, t, n.duckTypes)), a = e.children[0]?.data.length ?? 0;
  if (a === 0)
    return [O2(r.map((e, t) => D2(i[t], [], e.name)))];
  let o = [];
  for (let n = 0;n < a; n++) {
    let a = r.map((r, a) => {
      let o = e.children[a], s = o?.data[n], c = i[a];
      if (!o || !s || !c)
        throw new u(`Arrow table is missing batch ${n} for column ${r.name}`);
      return D2(c, Array.from({ length: s.length }, (e, t) => B2(s.at(t), c, r.type)), r.name);
    });
    o.push(O2(a));
  }
  return o;
}
function It(e, t = {}) {
  return e instanceof Table ? F2(e, t) : Ft(e, t);
}
function I2(e, t) {
  let n = new Map([[jt, un(t)]]);
  return t.id === v.GEOMETRY && n.set(Mt, "geoarrow.wkb"), {
    name: e,
    type: Lt(t),
    nullable: true,
    metadata: n
  };
}
function Lt(e) {
  switch (e.id) {
    case v.SQLNULL:
      return nullType();
    case v.BOOLEAN:
      return bool();
    case v.TINYINT:
      return int8();
    case v.SMALLINT:
      return int16();
    case v.INTEGER:
      return int32();
    case v.BIGINT:
      return int64();
    case v.UTINYINT:
      return uint8();
    case v.USMALLINT:
      return uint16();
    case v.UINTEGER:
      return uint32();
    case v.UBIGINT:
      return uint64();
    case v.HUGEINT:
      return decimal128(38, 0);
    case v.UHUGEINT:
      return decimal256(39, 0);
    case v.FLOAT:
      return float32();
    case v.DOUBLE:
      return float64();
    case v.DECIMAL: {
      let { width: t, scale: n } = H2(e);
      return t <= 9 ? decimal32(t, n) : t <= 18 ? decimal64(t, n) : decimal128(t, n);
    }
    case v.CHAR:
    case v.VARCHAR:
    case v.ENUM:
    case v.UUID:
      return utf8();
    case v.BLOB:
    case v.BIT:
    case v.GEOMETRY:
      return binary();
    case v.DATE:
      return dateDay();
    case v.TIME:
      return timeMicrosecond();
    case v.TIME_NS:
      return timeNanosecond();
    case v.TIME_TZ:
      return int64();
    case v.TIMESTAMP_SEC:
      return timestamp(TimeUnit.SECOND);
    case v.TIMESTAMP_MS:
      return timestamp(TimeUnit.MILLISECOND);
    case v.TIMESTAMP:
      return timestamp(TimeUnit.MICROSECOND);
    case v.TIMESTAMP_NS:
      return timestamp(TimeUnit.NANOSECOND);
    case v.TIMESTAMP_TZ:
      return timestamp(TimeUnit.MICROSECOND, "UTC");
    case v.TIMESTAMP_TZ_NS:
      return timestamp(TimeUnit.NANOSECOND, "UTC");
    case v.INTERVAL:
      return interval(IntervalUnit.MONTH_DAY_NANO);
    case v.LIST:
      return list(I2("item", E(e)));
    case v.MAP: {
      let n = D(E(e)), r = n.find((e) => e.name === "key") ?? n[0], i = n.find((e) => e.name === "value") ?? n[1];
      if (!r || !i)
        throw new u("DuckDB MAP type is missing key/value children");
      return map(I2("key", r.type), I2("value", i.type));
    }
    case v.STRUCT:
      return struct(D(e).map((e) => I2(e.name, e.type)));
    case v.TUPLE:
      return struct(D(e).map((e, t) => I2(String(t), e.type)));
    case v.ARRAY:
      return fixedSizeList(I2("item", E(e)), O(e));
    default:
      throw new d(`Cannot map DuckDB logical type ${v[e.id] ?? e.id} to Arrow`);
  }
}
function L2(e, t, n, r, i = null) {
  let a = n.length, { validity: o, nullCount: c } = an(n), l = batchType(e, r, i), u = {
    length: a,
    nullCount: c,
    type: e,
    validity: o
  };
  switch (e.typeId) {
    case Type.Null:
      return new l({
        ...u,
        nullCount: a
      });
    case Type.Bool:
      return new l({
        ...u,
        values: on(n)
      });
    case Type.Int:
    case Type.Float:
    case Type.Date:
    case Type.Time:
    case Type.Timestamp:
    case Type.Decimal:
    case Type.Interval:
      return new l({
        ...u,
        values: Rt(e, t, n)
      });
    case Type.Utf8:
    case Type.LargeUtf8:
      return new l({
        ...u,
        ...Ut(n, (e) => At.encode(String(e ?? "")))
      });
    case Type.Binary:
    case Type.LargeBinary:
      return new l({
        ...u,
        ...Ut(n, cn)
      });
    case Type.List:
    case Type.LargeList:
      return new l({
        ...u,
        ...Wt(e, t, n, r)
      });
    case Type.Map:
      return new l({
        ...u,
        ...Gt(e, t, n, r)
      });
    case Type.Struct:
      return new l({
        ...u,
        children: Kt(e, t, n, r)
      });
    case Type.FixedSizeList:
      return new l({
        ...u,
        children: qt(e, t, n, r)
      });
    default:
      throw new d(`Cannot build Arrow batch for type id ${e.typeId}`);
  }
}
function Rt(e, t, n) {
  switch (e.typeId) {
    case Type.Int:
    case Type.Date:
    case Type.Time:
    case Type.Timestamp: {
      let r = e.values, i = new r(U2(n.length, r.BYTES_PER_ELEMENT));
      return n.forEach((n, r) => {
        i[r] = zt(n, t, e);
      }), i;
    }
    case Type.Float: {
      let t = e.values, r = new t(U2(n.length, t.BYTES_PER_ELEMENT));
      return n.forEach((e, t) => {
        r[t] = Number(e ?? 0);
      }), r;
    }
    case Type.Decimal:
      return Vt(e, t, n);
    case Type.Interval:
      return Ht(n);
    default:
      throw new d(`Cannot create fixed Arrow values for type id ${e.typeId}`);
  }
}
function zt(e, t, n) {
  if (e === null)
    return Bt(n) ? 0n : 0;
  switch (t.id) {
    case v.DATE:
      return e.days;
    case v.TIME:
    case v.TIME_NS:
      return BigInt(e.value);
    case v.TIME_TZ:
      return BigInt(e.bits);
    case v.TIMESTAMP:
    case v.TIMESTAMP_SEC:
    case v.TIMESTAMP_MS:
    case v.TIMESTAMP_NS:
    case v.TIMESTAMP_TZ:
    case v.TIMESTAMP_TZ_NS:
      return BigInt(e.value);
    default:
      return typeof e == "bigint" ? e : Number(e);
  }
}
function Bt(e) {
  return "values" in e && (e.values === BigInt64Array || e.values === BigUint64Array);
}
function Vt(e, t, n) {
  let { scale: r } = H2(t);
  if (e.bitWidth === 32) {
    let e = new Int32Array(U2(n.length, Int32Array.BYTES_PER_ELEMENT));
    return n.forEach((n, i) => {
      e[i] = Number(sn(n, t, r));
    }), e;
  }
  let i = e.bitWidth >> 6, a = new BigUint64Array(U2(n.length * i, BigUint64Array.BYTES_PER_ELEMENT));
  return n.forEach((e, n) => {
    let o = sn(e, t, r), s = n * i;
    for (let e = 0;e < i; e++)
      a[s + e] = o >> BigInt(e * 64);
  }), a;
}
function Ht(e) {
  let t = new Uint8Array(U2(e.length * 16, Uint8Array.BYTES_PER_ELEMENT)), n = new DataView(t.buffer, t.byteOffset, t.byteLength);
  return e.forEach((e, t) => {
    let r = e, i = t * 16;
    n.setInt32(i, r?.months ?? 0, true), n.setInt32(i + 4, r?.days ?? 0, true), n.setBigInt64(i + 8, (r?.micros ?? 0n) * 1000n, true);
  }), t;
}
function Ut(e, t) {
  let n = new Int32Array(U2(e.length + 1, Int32Array.BYTES_PER_ELEMENT)), r = [], i = 0;
  e.forEach((e, a) => {
    if (n[a] = i, e !== null) {
      let n = t(e);
      r.push(n), i += n.byteLength;
    }
  }), n[e.length] = i;
  let a = new Uint8Array(U2(i, Uint8Array.BYTES_PER_ELEMENT)), o = 0;
  for (let e of r)
    a.set(e, o), o += e.byteLength;
  return {
    offsets: n,
    values: a
  };
}
function Wt(e, n, r, i) {
  let a = e.children[0];
  if (!a)
    throw new u("Arrow LIST type is missing child metadata");
  let o = E(n), s = new Int32Array(U2(r.length + 1, Int32Array.BYTES_PER_ELEMENT)), c = [];
  return r.forEach((e, t) => {
    s[t] = c.length, Array.isArray(e) && c.push(...e);
  }), s[r.length] = c.length, {
    offsets: s,
    children: [L2(a.type, o, c, i, a.metadata)]
  };
}
function Gt(e, t, n, r) {
  let i = e.children[0], a = E(t), o = new Int32Array(U2(n.length + 1, Int32Array.BYTES_PER_ELEMENT)), s = [];
  return n.forEach((e, t) => {
    o[t] = s.length, Array.isArray(e) && s.push(...e);
  }), o[n.length] = s.length, {
    offsets: o,
    children: [L2(i.type, a, s, r, i.metadata)]
  };
}
function Kt(e, n, r, i) {
  let a = D(n), o = n.id === v.TUPLE;
  return e.children.map((e, n) => {
    let s = a[n];
    if (!s)
      throw new u(`STRUCT child ${n} is missing DuckDB metadata`);
    let c = r.map((e) => o && Array.isArray(e) ? e[n] ?? null : e === null || Array.isArray(e) || e instanceof Uint8Array || typeof e != "object" ? null : e[s.name] ?? null);
    return L2(e.type, s.type, c, i, e.metadata);
  });
}
function qt(e, n, r, i) {
  let a = e.children[0];
  if (!a)
    throw new u("Arrow FixedSizeList type is missing child metadata");
  let o = E(n), s = [];
  for (let n of r)
    if (n === null)
      s.push(...Array.from({ length: e.stride }, () => null));
    else if (Array.isArray(n) && n.length === e.stride)
      s.push(...n);
    else
      throw new u(`ARRAY values must contain exactly ${e.stride} entries`);
  return [L2(a.type, o, s, i, a.metadata)];
}
function Jt(e, n, r) {
  if (Yt(r)) {
    let i = r[n];
    if (!i)
      throw new u(`Missing DuckDB type for Arrow column ${e.name}`);
    return i;
  }
  if (r) {
    let n = r[e.name];
    if (!n)
      throw new u(`Missing DuckDB type for Arrow column ${e.name}`);
    return n;
  }
  return dn(e) ?? R2(e.type);
}
function Yt(e) {
  return Array.isArray(e);
}
function R2(e) {
  switch (e.typeId) {
    case Type.Null:
      return oe.null();
    case Type.Bool:
      return oe.boolean();
    case Type.Int:
      return e.signed ? e.bitWidth === 8 ? oe.tinyint() : e.bitWidth === 16 ? oe.smallint() : e.bitWidth === 32 ? oe.integer() : oe.bigint() : e.bitWidth === 8 ? oe.utinyint() : e.bitWidth === 16 ? oe.usmallint() : e.bitWidth === 32 ? oe.uinteger() : oe.ubigint();
    case Type.Float:
      return e.precision === 2 ? oe.double() : oe.float();
    case Type.Decimal:
      return oe.decimal(e.precision, e.scale);
    case Type.Utf8:
    case Type.LargeUtf8:
      return oe.varchar();
    case Type.Binary:
    case Type.LargeBinary:
    case Type.FixedSizeBinary:
      return oe.blob();
    case Type.Date:
      return oe.date();
    case Type.Time:
      return e.unit === TimeUnit.NANOSECOND ? oe.timeNs() : oe.time();
    case Type.Timestamp:
      return e.timezone ? e.unit === TimeUnit.NANOSECOND ? oe.timestampTzNanos() : oe.timestampTz() : e.unit === TimeUnit.SECOND ? oe.timestampSeconds() : e.unit === TimeUnit.MILLISECOND ? oe.timestampMillis() : e.unit === TimeUnit.NANOSECOND ? oe.timestampNanos() : oe.timestamp();
    case Type.Interval:
      return oe.interval();
    case Type.List:
    case Type.LargeList:
      return oe.list(z2(e.children[0]));
    case Type.FixedSizeList:
      return oe.array(z2(e.children[0]), e.stride);
    case Type.Struct:
      return oe.struct(e.children.map((e) => ({
        name: e.name,
        type: z2(e)
      })));
    case Type.Map: {
      let t = e.children[0]?.type;
      if (!t || t.typeId !== Type.Struct)
        throw new d("Arrow Map type is missing entries struct metadata");
      let n = t.children[0], r = t.children[1];
      if (!n || !r)
        throw new d("Arrow Map type is missing key/value metadata");
      return oe.map(z2(n), z2(r));
    }
    case Type.Dictionary:
      return R2(e.dictionary);
    default:
      throw new d(`Cannot infer a DuckDB type from Arrow type id ${e.typeId}`);
  }
}
function z2(e) {
  if (!e)
    throw new u("Arrow field is missing");
  return dn(e) ?? R2(e.type);
}
function B2(e, t, n) {
  if (e == null)
    return null;
  switch (t.id) {
    case v.DECIMAL:
      return typeof e == "bigint" ? e : String(e);
    case v.HUGEINT:
    case v.UHUGEINT:
      return typeof e == "bigint" ? e : BigInt(Math.trunc(Number(e)));
    case v.DATE:
      return e instanceof Date ? ut(e) : {
        kind: "date",
        days: Math.trunc(Number(e) / 86400000)
      };
    case v.TIME:
      return {
        kind: "time",
        unit: "micros",
        value: Zt(e, n, "micros")
      };
    case v.TIME_NS:
      return {
        kind: "time",
        unit: "nanos",
        value: Zt(e, n, "nanos")
      };
    case v.TIME_TZ:
      return {
        kind: "time_tz",
        bits: BigInt(e)
      };
    case v.TIMESTAMP:
    case v.TIMESTAMP_SEC:
    case v.TIMESTAMP_MS:
    case v.TIMESTAMP_NS:
    case v.TIMESTAMP_TZ:
    case v.TIMESTAMP_TZ_NS:
      return Xt(e, t, n);
    case v.INTERVAL:
      return Qt(e);
    case v.LIST:
      return Array.from(e, (e) => B2(e, E(t), V2(n)));
    case v.ARRAY:
      return Array.from(e, (e) => B2(e, E(t), V2(n)));
    case v.MAP:
      return $t(e, t, n);
    case v.STRUCT:
      return en(e, t, n);
    case v.TUPLE:
      return D(t).map((t, r) => B2(e[String(r)], t.type, V2(n, r)));
    default:
      return e instanceof Uint8Array, e;
  }
}
function Xt(e, t, n) {
  let r = tn(t), i = t.id === v.TIMESTAMP_TZ || t.id === v.TIMESTAMP_TZ_NS ? "utc" : undefined;
  if (e instanceof Date)
    return gt(e, r, i);
  let a = typeof e == "bigint" && n.typeId === Type.Timestamp ? nn(e, n.unit, r) : rn(Number(e), r);
  return i === undefined ? {
    kind: "timestamp",
    unit: r,
    value: a
  } : {
    kind: "timestamp",
    unit: r,
    value: a,
    timezone: i
  };
}
function Zt(e, t, n) {
  let r = BigInt(e);
  if (t.typeId !== Type.Time)
    return r;
  let i = t.unit === TimeUnit.SECOND ? r * 1000000n : t.unit === TimeUnit.MILLISECOND ? r * 1000n : t.unit === TimeUnit.NANOSECOND ? r / 1000n : r;
  return n === "nanos" ? i * 1000n : i;
}
function Qt(e) {
  let t = Array.from(e);
  return {
    kind: "interval",
    months: Number(t[0] ?? 0),
    days: Number(t[1] ?? 0),
    micros: BigInt(Math.trunc(Number(t[2] ?? 0) / 1000))
  };
}
function $t(e, n, r) {
  let i = E(n), a = V2(r);
  if (a.typeId !== Type.Struct)
    throw new u("Arrow Map entries must be STRUCT values");
  let o = D(i), s = o[0]?.type, c = o[1]?.type, l = a.children[0]?.type, u2 = a.children[1]?.type;
  if (!s || !c || !l || !u2)
    throw new u("Arrow Map entries are missing key/value metadata");
  return (e instanceof Map ? Array.from(e.entries()) : Array.from(e)).map((e) => Array.isArray(e) ? {
    key: B2(e[0], s, l),
    value: B2(e[1], c, u2)
  } : en(e, i, a));
}
function en(e, t, n) {
  let r = D(t), i = {};
  return r.forEach((t, r) => {
    i[t.name] = B2(e[t.name], t.type, V2(n, r));
  }), i;
}
function V2(e, n = 0) {
  if ("children" in e) {
    let r = e.children[n];
    if (!r)
      throw new u(`Arrow type id ${e.typeId} is missing child ${n}`);
    return r.type;
  }
  throw new u(`Arrow type id ${e.typeId} does not have children`);
}
function tn(e) {
  switch (e.id) {
    case v.TIMESTAMP_SEC:
      return "seconds";
    case v.TIMESTAMP_MS:
      return "millis";
    case v.TIMESTAMP_NS:
    case v.TIMESTAMP_TZ_NS:
      return "nanos";
    default:
      return "micros";
  }
}
function nn(e, t, n) {
  let r = t === TimeUnit.SECOND ? e * 1000000000n : t === TimeUnit.MILLISECOND ? e * 1000000n : t === TimeUnit.MICROSECOND ? e * 1000n : e;
  switch (n) {
    case "seconds":
      return r / 1000000000n;
    case "millis":
      return r / 1000000n;
    case "micros":
      return r / 1000n;
    case "nanos":
      return r;
  }
}
function rn(e, t) {
  switch (t) {
    case "seconds":
      return BigInt(Math.trunc(e / 1000));
    case "millis":
      return BigInt(Math.trunc(e));
    case "micros":
      return BigInt(Math.trunc(e * 1000));
    case "nanos":
      return BigInt(Math.trunc(e * 1e6));
  }
}
function an(e) {
  let t = 0;
  for (let n of e)
    n === null && t++;
  if (t === 0)
    return {
      validity: new Uint8Array,
      nullCount: t
    };
  let n = new Uint8Array(U2(Math.ceil(e.length / 8), Uint8Array.BYTES_PER_ELEMENT));
  return e.forEach((e, t) => {
    e !== null && (n[t >> 3] = (n[t >> 3] ?? 0) | 1 << t % 8);
  }), {
    validity: n,
    nullCount: t
  };
}
function on(e) {
  let t = new Uint8Array(U2(Math.ceil(e.length / 8), Uint8Array.BYTES_PER_ELEMENT));
  return e.forEach((e, n) => {
    e === true && (t[n >> 3] = (t[n >> 3] ?? 0) | 1 << n % 8);
  }), t;
}
function sn(e, t, n) {
  if (e === null)
    return 0n;
  if (typeof e == "object" && !Array.isArray(e) && !(e instanceof Uint8Array)) {
    let t = e;
    if (t.kind === "decimal")
      return BigInt(t.value);
  }
  if (typeof e == "bigint")
    return e;
  let { width: r } = H2(t);
  return ct(e, r, n).value;
}
function H2(e) {
  let n = e.typeInfo;
  if (n?.type !== y.DECIMAL)
    throw new u("DECIMAL type is missing DecimalTypeInfo");
  return {
    width: n.width,
    scale: n.scale
  };
}
function cn(e) {
  return e instanceof Uint8Array ? e : At.encode(String(e ?? ""));
}
function ln(e, t, n) {
  return e ? [...e] : t?.columnNames ? [...t.columnNames] : Array.from({ length: n }, (e, t) => `column${t}`);
}
function un(e) {
  return JSON.stringify(e, (e, t) => typeof t == "bigint" ? { [M2]: t.toString() } : t);
}
function dn(e) {
  let t = e.metadata, n = t instanceof Map ? t.get(jt) : undefined;
  return n ? fn(n) : undefined;
}
function fn(e) {
  return JSON.parse(e, (e, t) => t && typeof t == "object" && (M2 in t) ? BigInt(String(t[M2])) : t);
}
function pn(e) {
  return {
    ...e.useDate === undefined ? {} : { useDate: e.useDate },
    ...e.useDecimalInt === undefined ? {} : { useDecimalInt: e.useDecimalInt },
    ...e.useBigInt === undefined ? {} : { useBigInt: e.useBigInt },
    ...e.useBigIntTimestamp === undefined ? {} : { useBigIntTimestamp: e.useBigIntTimestamp },
    ...e.useMap === undefined ? {} : { useMap: e.useMap },
    ...e.useProxy === undefined ? {} : { useProxy: e.useProxy },
    ...e.useGeoJSON === undefined ? {} : { useGeoJSON: e.useGeoJSON }
  };
}
function U2(e, t) {
  return (e * t + 7 & -8) / t;
}
function W2(e, t = {}) {
  if (e === null || typeof e == "boolean" || typeof e == "number" || typeof e == "string")
    return e;
  if (typeof e == "bigint")
    return gn(e, t);
  if (e instanceof Uint8Array)
    return _n(e, t);
  if (Array.isArray(e))
    return e.map((e) => W2(e, t));
  if (Cn(e))
    return t.decimal === "tagged" ? {
      kind: "decimal",
      value: e.value.toString(),
      width: e.width,
      scale: e.scale
    } : _e(e);
  if (wn(e))
    return t.date === "tagged" ? {
      kind: "date",
      days: e.days
    } : vn(e);
  if (Tn(e))
    return t.time === "tagged" ? {
      kind: "time",
      unit: e.unit,
      value: e.value.toString()
    } : yn(e);
  if (En(e))
    return {
      kind: "time_tz",
      bits: e.bits.toString()
    };
  if (Dn(e))
    return t.timestamp === "tagged" ? {
      kind: "timestamp",
      unit: e.unit,
      value: e.value.toString(),
      ...e.timezone === undefined ? {} : { timezone: e.timezone }
    } : bn(e);
  if (On(e))
    return {
      kind: "interval",
      months: e.months,
      days: e.days,
      micros: e.micros.toString()
    };
  let n = {};
  for (let [r, i] of Object.entries(e))
    n[r] = W2(i, t);
  return n;
}
function mn(e, t = {}) {
  return W2(e, t);
}
function hn(e, t = {}) {
  return e.map((e) => mn(e, t));
}
function gn(e, n) {
  if (n.bigint !== "number")
    return e.toString();
  if (e > BigInt(2 ** 53 - 1) || e < BigInt(-(2 ** 53 - 1)))
    throw new u(`bigint value ${e.toString()} exceeds JavaScript safe integer range`);
  return Number(e);
}
function _n(e, n) {
  switch (n.bytes ?? "base64") {
    case "array":
      return [...e];
    case "hex":
      return [...e].map((e) => e.toString(16).padStart(2, "0")).join("");
    case "base64":
      return Sn(e);
    default:
      throw new u(`Unhandled JSON bytes conversion option ${String(n.bytes)}`);
  }
}
function vn(e) {
  return (/* @__PURE__ */ new Date(e.days * 86400000)).toISOString().slice(0, 10);
}
function yn(e) {
  let t = e.unit === "nanos" ? e.value : e.value * 1000n, n = xn(t, 1000000000n), r = t - n * 1000000000n, i = n / 3600n, a = n % 3600n / 60n, o = n % 60n, s = r === 0n ? "" : `.${r.toString().padStart(9, "0").replace(/0+$/, "")}`;
  return `${i.toString().padStart(2, "0")}:${a.toString().padStart(2, "0")}:${o.toString().padStart(2, "0")}${s}`;
}
function bn(e) {
  let n = e.unit === "seconds" ? e.value * 1000000000n : e.unit === "millis" ? e.value * 1000000n : e.unit === "micros" ? e.value * 1000n : e.value, r = xn(n, 1000000000n), i = n - r * 1000000000n, a = r * 1000n;
  if (a > BigInt(2 ** 53 - 1) || a < BigInt(-(2 ** 53 - 1)))
    throw new u(`timestamp value ${e.value.toString()} is outside JavaScript Date range`);
  return `${new Date(Number(a)).toISOString().replace(".000Z", "")}${i === 0n ? "" : `.${i.toString().padStart(9, "0").replace(/0+$/, "")}`}Z`;
}
function xn(e, t) {
  let n = e / t;
  return e % t < 0n ? n - 1n : n;
}
function Sn(e) {
  let t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", n = "";
  for (let r = 0;r < e.length; r += 3) {
    let i = e[r] ?? 0, a = e[r + 1] ?? 0, o = e[r + 2] ?? 0, s = i << 16 | a << 8 | o;
    n += t[s >> 18 & 63], n += t[s >> 12 & 63], n += r + 1 < e.length ? t[s >> 6 & 63] : "=", n += r + 2 < e.length ? t[s & 63] : "=";
  }
  return n;
}
function Cn(e) {
  return e.kind === "decimal";
}
function wn(e) {
  return e.kind === "date";
}
function Tn(e) {
  return e.kind === "time";
}
function En(e) {
  return e.kind === "time_tz";
}
function Dn(e) {
  return e.kind === "timestamp";
}
function On(e) {
  return e.kind === "interval";
}
function G2(e, t) {
  return t === undefined ? e : In(t) ? kn(e, t) : An(e, t);
}
function K2(e) {
  if (e === undefined)
    throw TypeError("SQL parameter value is undefined; use null for SQL NULL");
  if (e === null)
    return "NULL";
  if (Array.isArray(e))
    return `[${e.map((e) => K2(e)).join(", ")}]`;
  if (typeof e == "boolean")
    return e ? "TRUE" : "FALSE";
  if (typeof e == "number") {
    if (!Number.isFinite(e))
      throw TypeError(`Cannot encode non-finite SQL number ${e}`);
    return String(e);
  }
  if (typeof e == "bigint")
    return e.toString();
  if (typeof e == "string")
    return `'${e.replaceAll("'", "''")}'`;
  if (e instanceof Uint8Array)
    return `from_hex('${Ln(e)}')`;
  if (e instanceof Date)
    return `TIMESTAMP '${Bn(e, "millis")}'`;
  if (Hn(e))
    return _e(e);
  if (Un(e))
    return `DATE '${Rn(e.days)}'`;
  if (Wn(e))
    return `TIME '${Vn(e.value, e.unit)}'`;
  if (Gn(e))
    throw TypeError("TIME WITH TIME ZONE parameters are not supported as SQL literals");
  if (Kn(e))
    return `${e.timezone === "utc" ? "TIMESTAMPTZ" : "TIMESTAMP"} '${zn(e)}'`;
  if (qn(e))
    return `INTERVAL '${e.months} months ${e.days} days ${e.micros.toString()} microseconds'`;
  if (typeof e == "object")
    throw TypeError("Object SQL parameters are not supported; pass scalar values or arrays");
  return String(e);
}
function q2(e) {
  return `"${e.replaceAll('"', '""')}"`;
}
function J2(e) {
  switch (e.id) {
    case v.SQLNULL:
      return '"NULL"';
    case v.BOOLEAN:
    case v.TINYINT:
    case v.SMALLINT:
    case v.INTEGER:
    case v.BIGINT:
    case v.UTINYINT:
    case v.USMALLINT:
    case v.UINTEGER:
    case v.UBIGINT:
    case v.HUGEINT:
    case v.UHUGEINT:
    case v.FLOAT:
    case v.DOUBLE:
    case v.VARCHAR:
    case v.BLOB:
    case v.BIT:
    case v.BIGNUM:
    case v.UUID:
    case v.DATE:
    case v.TIME:
    case v.TIME_NS:
    case v.TIMESTAMP:
    case v.TIMESTAMP_MS:
    case v.TIMESTAMP_NS:
    case v.INTERVAL:
    case v.VARIANT:
      return v[e.id];
    case v.CHAR:
      return "VARCHAR";
    case v.TIMESTAMP_SEC:
      return "TIMESTAMP_S";
    case v.TIMESTAMP_TZ:
      return "TIMESTAMP WITH TIME ZONE";
    case v.TIMESTAMP_TZ_NS:
      return "TIMESTAMPTZ_NS";
    case v.TIME_TZ:
      return "TIME WITH TIME ZONE";
    case v.DECIMAL: {
      let t = e.typeInfo;
      return t?.type === y.DECIMAL ? `DECIMAL(${t.width},${t.scale})` : "DECIMAL";
    }
    case v.ENUM:
      return `ENUM(${k(e).map((e) => K2(e)).join(", ")})`;
    case v.LIST:
      return `${J2(E(e))}[]`;
    case v.ARRAY:
      return `${J2(E(e))}[${O(e)}]`;
    case v.MAP: {
      let [t, n] = D(E(e));
      if (!t || !n)
        throw new d("MAP type is missing key/value children");
      return `MAP(${J2(t.type)}, ${J2(n.type)})`;
    }
    case v.STRUCT:
      return `STRUCT(${D(e).map((e) => `${q2(e.name)} ${J2(e.type)}`).join(", ")})`;
    case v.TUPLE:
      return `TUPLE(${D(e).map((e) => J2(e.type)).join(", ")})`;
    case v.GEOMETRY: {
      let t = e.typeInfo?.type === y.GEO ? e.typeInfo.crs?.definition : undefined;
      return t ? `GEOMETRY(${K2(t)})` : "GEOMETRY";
    }
    default:
      throw new d(`Cannot render DuckDB logical type ${v[e.id] ?? e.id} as SQL`);
  }
}
function kn(e, t) {
  let n = 0, r = jn(e, (e) => {
    if (e !== "?")
      return e;
    let r = t[n];
    if (n >= t.length)
      throw Error("SQL has more positional placeholders than parameters");
    return n++, K2(r);
  });
  if (n !== t.length)
    throw Error(`SQL has ${n} positional placeholders but ${t.length} parameters were provided`);
  return r;
}
function An(e, t) {
  return jn(e, (e) => {
    if (!e.startsWith(":"))
      return e;
    let n = e.slice(1);
    if (!(n in t))
      throw Error(`Missing SQL parameter :${n}`);
    return K2(t[n]);
  });
}
function jn(e, t) {
  let n = "", r = 0;
  for (;r < e.length; ) {
    let i = e[r], a = e[r + 1];
    if (i === "'") {
      let { text: t, end: i } = Mn(e, r);
      n += t, r = i;
      continue;
    }
    if (i === '"') {
      let { text: t, end: i } = Nn(e, r);
      n += t, r = i;
      continue;
    }
    if (i === "-" && a === "-") {
      let t = e.indexOf(`
`, r + 2), i = t < 0 ? e.length : t;
      n += e.slice(r, i), r = i;
      continue;
    }
    if (i === "/" && a === "*") {
      let t = e.indexOf("*/", r + 2), i = t < 0 ? e.length : t + 2;
      n += e.slice(r, i), r = i;
      continue;
    }
    if (i === "?") {
      n += t("?"), r++;
      continue;
    }
    if (i === ":" && e[r - 1] !== ":" && a !== ":" && Pn(a ?? "")) {
      let i = r + 1, a = i + 1;
      for (;a < e.length && Fn(e[a] ?? ""); )
        a++;
      n += t(`:${e.slice(i, a)}`), r = a;
      continue;
    }
    n += i, r++;
  }
  return n;
}
function Mn(e, t) {
  let n = t + 1;
  for (;n < e.length; ) {
    if (e[n] === "'" && e[n + 1] === "'") {
      n += 2;
      continue;
    }
    if (e[n] === "'") {
      n++;
      break;
    }
    n++;
  }
  return {
    text: e.slice(t, n),
    end: n
  };
}
function Nn(e, t) {
  let n = t + 1;
  for (;n < e.length; ) {
    if (e[n] === '"' && e[n + 1] === '"') {
      n += 2;
      continue;
    }
    if (e[n] === '"') {
      n++;
      break;
    }
    n++;
  }
  return {
    text: e.slice(t, n),
    end: n
  };
}
function Pn(e) {
  return /^[A-Za-z_]$/.test(e);
}
function Fn(e) {
  return /^[A-Za-z0-9_]$/.test(e);
}
function In(e) {
  return Array.isArray(e);
}
function Ln(e) {
  return [...e].map((e) => e.toString(16).padStart(2, "0")).join("");
}
function Rn(e) {
  return (/* @__PURE__ */ new Date(e * 86400000)).toISOString().slice(0, 10);
}
function zn(e) {
  let t = e.unit === "seconds" ? e.value * 1000000n : e.unit === "millis" ? e.value * 1000n : e.unit === "nanos" ? e.value / 1000n : e.value;
  return `${new Date(Number(t / 1000n)).toISOString().replace("T", " ").replace("Z", "")}${e.timezone === "utc" ? "+00" : ""}`;
}
function Bn(e, t) {
  return e.toISOString().replace("T", " ").replace("Z", "");
}
function Vn(e, t) {
  let n = t === "nanos" ? e : e * 1000n, r = n / 1000000000n, i = n % 1000000000n, a = r / 3600n, o = r % 3600n / 60n, s = r % 60n, c = i === 0n ? "" : `.${i.toString().padStart(9, "0").replace(/0+$/, "")}`;
  return `${a.toString().padStart(2, "0")}:${o.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}${c}`;
}
function Hn(e) {
  return e.kind === "decimal";
}
function Un(e) {
  return e.kind === "date";
}
function Wn(e) {
  return e.kind === "time";
}
function Gn(e) {
  return e.kind === "time_tz";
}
function Kn(e) {
  return e.kind === "timestamp";
}
function qn(e) {
  return e.kind === "interval";
}
var Jn = c * 16;
var Y2 = 5000;
var Yn = class e {
  baseUrl;
  fetchImpl;
  info;
  headers;
  heartbeatEnabled;
  acknowledgeResults;
  connectionId;
  closed = false;
  invalidatedReason;
  nextQueryId = 1n;
  heartbeatTimeoutSeconds = 60;
  heartbeatTimer;
  lastRequestAt = 0;
  statementTail = Promise.resolve();
  statementGeneration = 0;
  activeStatement;
  constructor(e, n = {}) {
    if (this.baseUrl = e.replace(/\/$/, ""), this.fetchImpl = n.fetch ?? globalThis.fetch, this.headers = n.headers, this.heartbeatEnabled = n.heartbeat ?? true, this.acknowledgeResults = n.acknowledgeResults ?? false, !this.fetchImpl)
      throw new u("No fetch implementation is available");
  }
  static async connect(n, r = {}) {
    let i = Xn(n, r.ssl), a = tr(r.heartbeatTimeoutSeconds ?? 60);
    if (r.clientId !== undefined && r.clientId !== "" && r.clientId.length < 4)
      throw new u("clientId must be at least 4 characters long");
    let o = new e(i.baseUrl, r), s = {
      type: J.CONNECTION_REQUEST,
      clientPlatform: r.clientPlatform ?? er(),
      minSupportedQuackVersion: r.minSupportedQuackVersion ?? 3,
      maxSupportedQuackVersion: r.maxSupportedQuackVersion ?? 3,
      heartbeatTimeoutSeconds: a
    };
    r.authToken !== undefined && (s.authString = r.authToken), r.clientDuckdbVersion !== undefined && (s.clientDuckdbVersion = r.clientDuckdbVersion), r.clientId !== undefined && (s.clientId = r.clientId);
    let c = await o.send(s, r);
    if (c.type !== J.CONNECTION_RESPONSE)
      throw new u(`Expected CONNECTION_RESPONSE, got ${J[c.type] ?? c.type}`);
    if (!c.connectionId)
      throw new u("CONNECTION_RESPONSE did not include a connection id");
    if (o.connectionId = c.connectionId, c.quackVersion !== BigInt(3))
      throw await o.disconnect().catch(() => {
        return;
      }), new u(`Incompatible Quack protocol version: server uses ${c.quackVersion ?? "unknown"}, client supports 3`);
    return c.heartbeatTimeoutSeconds !== undefined && c.heartbeatTimeoutSeconds > 0n ? o.heartbeatTimeoutSeconds = tr(c.heartbeatTimeoutSeconds) : o.heartbeatTimeoutSeconds = a, o.info = {
      ...c.serverDuckdbVersion === undefined ? {} : { serverDuckdbVersion: c.serverDuckdbVersion },
      ...c.serverPlatform === undefined ? {} : { serverPlatform: c.serverPlatform },
      ...c.quackVersion === undefined ? {} : { quackVersion: c.quackVersion },
      heartbeatTimeoutSeconds: o.heartbeatTimeoutSeconds
    }, o.scheduleHeartbeat(), o;
  }
  static async withConnection(n, r, i) {
    let a = typeof r == "function" ? {} : r, o = typeof r == "function" ? r : i;
    if (!o)
      throw new u("withConnection requires a callback");
    let s = await e.connect(n, a);
    try {
      return await o(s);
    } finally {
      await s.disconnect();
    }
  }
  get isConnected() {
    return !!this.connectionId && !this.closed && this.invalidatedReason === undefined;
  }
  async query(e, t, n) {
    let r = Q2(t, n), i = G2(e, r.params), { prepare: a, chunks: o } = await this.withStatement(async (e) => {
      let t = await this.prepare(i, e, r), n = Z2(t.results, t.resultNames);
      if (t.needsMoreFetch)
        for (let i = 1;; i++) {
          let a = await this.fetchBatch(e, i, r);
          if (a.results.length === 0)
            break;
          n.push(...Z2(a.results, t.resultNames));
        }
      return await this.acknowledge(e), {
        prepare: t,
        chunks: n
      };
    });
    return {
      names: a.resultNames,
      types: a.resultTypes,
      chunks: o,
      rows: () => ge(o, a.resultNames),
      jsonRows: (e = {}) => hn(ge(o, a.resultNames), e)
    };
  }
  async queryArrow(e, t, n) {
    let r = $2(t, n), i = await this.query(e, r);
    return N2(i.chunks, i.names, {
      ...r,
      duckTypes: i.types
    });
  }
  async queryArrowIPC(e, t, n) {
    let r = $2(t, n);
    return P2(await this.queryArrow(e, r), r);
  }
  async first(e, t, n) {
    return (await this.query(e, Q2(t, n))).rows()[0] ?? null;
  }
  async one(e, n, r) {
    let i = (await this.query(e, Q2(n, r))).rows();
    if (i.length !== 1)
      throw new u(`Expected exactly one row, got ${i.length}`);
    return i[0];
  }
  async values(e, t, n) {
    let r = await this.query(e, Q2(t, n)), i = r.names[0];
    return i ? r.rows().map((e) => e[i]) : [];
  }
  async* stream(e, n, r) {
    let i = Q2(n, r), a = G2(e, i.params), o, s = await this.withStatement(async (e) => (o = e, this.prepare(a, e, i)), { keepActive: true }), c = o, l = !s.needsMoreFetch;
    try {
      for (let e of Z2(s.results, s.resultNames))
        yield e;
      for (let e = 1;!l; e++) {
        let n = await this.withStatementSlot(async () => {
          if (this.statementGeneration !== c.generation)
            throw new u("Stream was interrupted by another statement on the same Quack client");
          return this.fetchBatch(c, e, i);
        });
        if (n.results.length === 0) {
          l = true;
          break;
        }
        for (let e of Z2(n.results, s.resultNames))
          yield e;
      }
      await this.acknowledge(c);
    } finally {
      !l && this.statementGeneration === c.generation && await this.cancelQuietly(c), this.endStatement(c);
    }
  }
  async* streamRows(e, t, n) {
    for await (let r of this.stream(e, Q2(t, n)))
      for (let e of ge([r]))
        yield e;
  }
  async* streamArrow(e, t, n) {
    let r = $2(t, n);
    for await (let t of this.stream(e, r))
      yield Nt(t, t.columnNames, r);
  }
  async append(e, n, r) {
    this.ensureOpen();
    let { target: i, options: a } = dr(e, r), o = nr(n) ? n : [n], s = o[0]?.types;
    if (!s || s.length === 0)
      throw new u("append requires at least one chunk with at least one column");
    for (let e of o)
      if (e.types.length !== s.length || e.types.some((e, t) => e.id !== s[t]?.id))
        throw new u("All append chunks must have the same column types");
    let c = rr(o), l = sr(), u2 = `NULL::STRUCT(${s.map((e, t) => `col${t} ${J2(e)}`).join(", ")})`, ee = `INSERT INTO ${i} SELECT * FROM scan_data_from_quack_client(${K2(l)}, ${u2}, ordered := true)`;
    return this.withStatement(async (e) => {
      await this.prepare(ee, e, {
        ...a,
        inlineRows: 0
      });
      for (let e = 0;e < c.length; e++)
        await this.sendData({
          type: J.SEND_DATA_REQUEST,
          connectionId: this.getConnectionId(),
          clientQueryId: this.allocateQueryId(),
          streamId: l,
          chunks: c[e],
          batchIndex: e + 1
        }, a);
      await this.sendData({
        type: J.SEND_DATA_REQUEST,
        connectionId: this.getConnectionId(),
        clientQueryId: this.allocateQueryId(),
        streamId: l,
        chunks: [],
        totalBatches: c.length
      }, a);
      let t = (await this.fetchBatch(e, 1, a)).results[0]?.columns[0]?.values[0];
      return t == null ? 0 : Number(t);
    }, { cancelOnServerError: true });
  }
  async appendRows(e, n, r = {}) {
    let i = r.columns === undefined ? {} : { columns: r.columns };
    if (n.length === 0)
      return this.append(e, k2(n, i), r);
    let a = r.batchSize ?? n.length;
    if (a < 1)
      throw new u("appendRows batchSize must be at least 1");
    let o = [];
    for (let e = 0;e < n.length; e += a)
      o.push(k2(n.slice(e, e + a), i));
    return this.append(e, o, r);
  }
  async appendArrow(e, t, n = {}) {
    return this.append(e, It(t, n), n);
  }
  async transaction(e, t = {}) {
    await this.query("BEGIN TRANSACTION", t);
    try {
      let n = await e(this);
      return await this.query("COMMIT", t), n;
    } catch (e) {
      try {
        await this.query("ROLLBACK", t);
      } catch {}
      throw e;
    }
  }
  async cancel(e = {}) {
    let t = this.activeStatement;
    return !t || !this.isConnected ? false : (X2(await this.send({
      type: J.CANCEL_REQUEST,
      connectionId: this.getConnectionId(),
      clientQueryId: this.allocateQueryId(),
      queryUuid: t.queryUuid
    }, e), J.SUCCESS_RESPONSE), true);
  }
  async heartbeat(e = {}) {
    this.ensureOpen(), X2(await this.send({
      type: J.HEARTBEAT_REQUEST,
      connectionId: this.getConnectionId(),
      clientQueryId: this.allocateQueryId()
    }, e), J.SUCCESS_RESPONSE);
  }
  async disconnect(e = {}) {
    this.stopHeartbeat();
    let t = this.connectionId;
    if (this.closed || !t) {
      this.closed = true;
      return;
    }
    this.closed = true, this.connectionId = undefined, this.invalidatedReason === undefined && X2(await this.send({
      type: J.DISCONNECT_MESSAGE,
      connectionId: t,
      clientQueryId: this.allocateQueryId()
    }, e), J.SUCCESS_RESPONSE);
  }
  async close(e = {}) {
    await this.disconnect(e);
  }
  async send(e, n2 = {}) {
    let r2 = Ge(e), i = new ArrayBuffer(r2.byteLength);
    new Uint8Array(i).set(r2);
    let { signal: a, cleanup: s } = fr(n2), c, l;
    this.lastRequestAt = Date.now();
    try {
      let e = {
        method: "POST",
        headers: {
          Accept: r,
          "Content-Type": r,
          ...this.headers
        },
        body: i
      };
      if (a !== undefined && (e.signal = a), c = await this.fetchImpl(`${this.baseUrl}${n}`, e), !c.ok)
        throw new u(`Quack HTTP request failed with ${c.status} ${c.statusText}`);
      l = new Uint8Array(await c.arrayBuffer());
    } finally {
      s();
    }
    let u2 = Ke(l);
    if (u2.type === J.ERROR_RESPONSE)
      throw u2.mustInvalidate && (this.invalidatedReason = u2.message, this.stopHeartbeat()), new ee(u2.message, {
        ...u2.exceptionType === undefined ? {} : { exceptionType: u2.exceptionType },
        ...u2.extraInfo === undefined ? {} : { extraInfo: u2.extraInfo },
        ...u2.mustInvalidate === undefined ? {} : { mustInvalidate: u2.mustInvalidate }
      });
    return u2;
  }
  async prepare(e, t, n = {}) {
    return X2(await this.send({
      type: J.PREPARE_REQUEST,
      connectionId: this.getConnectionId(),
      clientQueryId: this.allocateQueryId(),
      sql: e,
      queryUuid: t.queryUuid,
      ...n.inlineRows === undefined ? {} : { inlineRows: n.inlineRows }
    }, n), J.PREPARE_RESPONSE);
  }
  async fetchBatch(e, n, r = {}) {
    let i = X2(await this.send({
      type: J.FETCH_REQUEST,
      connectionId: this.getConnectionId(),
      clientQueryId: this.allocateQueryId(),
      queryUuid: e.queryUuid,
      batchIndex: n,
      ackIndex: n - 1
    }, r), J.FETCH_RESPONSE);
    if (i.results.length === 0) {
      let e = BigInt(n - 1);
      if (i.totalBatches !== undefined && i.totalBatches !== e)
        throw new u(`Result ended after ${e} batches but the server announced ${i.totalBatches}`);
    } else if (i.batchIndex !== BigInt(n))
      throw new u(`FETCH_RESPONSE carries batch ${i.batchIndex ?? "none"} but batch ${n} was requested`);
    return i;
  }
  async sendData(e, t) {
    X2(await this.send(e, t), J.SEND_DATA_RESPONSE);
  }
  async acknowledge(e) {
    if (!(!this.acknowledgeResults || !this.isConnected))
      try {
        await this.send({
          type: J.ACKNOWLEDGEMENT,
          connectionId: this.getConnectionId(),
          clientQueryId: this.allocateQueryId(),
          queryUuid: e.queryUuid
        }, { timeoutMs: Y2 });
      } catch {}
  }
  async cancelQuietly(e) {
    if (this.isConnected)
      try {
        await this.send({
          type: J.CANCEL_REQUEST,
          connectionId: this.getConnectionId(),
          clientQueryId: this.allocateQueryId(),
          queryUuid: e.queryUuid
        }, { timeoutMs: Y2 });
      } catch {}
  }
  async withStatement(e, { keepActive: t = false, cancelOnServerError: n = false } = {}) {
    return this.withStatementSlot(async () => {
      this.ensureOpen();
      let r = this.beginStatement(), i = false;
      try {
        let t = await e(r);
        return i = true, t;
      } catch (e) {
        throw (n || !(e instanceof ee)) && await this.cancelQuietly(r), e;
      } finally {
        (!i || !t) && this.endStatement(r);
      }
    });
  }
  async withStatementSlot(e) {
    let t, n = new Promise((e) => {
      t = e;
    }), r = this.statementTail;
    this.statementTail = r.then(() => n), await r;
    try {
      return await e();
    } finally {
      t();
    }
  }
  beginStatement() {
    let e = {
      generation: ++this.statementGeneration,
      queryUuid: or()
    };
    return this.activeStatement = e, e;
  }
  endStatement(e) {
    this.activeStatement === e && (this.activeStatement = undefined);
  }
  scheduleHeartbeat() {
    if (!this.heartbeatEnabled || !this.isConnected)
      return;
    let e = this.heartbeatTimeoutSeconds * 1000 / 3, t = Math.min(e * (0.8 + Math.random() * 0.4), 2147483647), n = setTimeout(() => {
      this.heartbeatTimer = undefined, this.heartbeatTick(e);
    }, t);
    cr(n), this.heartbeatTimer = n;
  }
  async heartbeatTick(e) {
    if (this.isConnected) {
      if (Date.now() - this.lastRequestAt >= e / 2)
        try {
          await this.heartbeat({ timeoutMs: Y2 });
        } catch {}
      this.scheduleHeartbeat();
    }
  }
  stopHeartbeat() {
    this.heartbeatTimer !== undefined && (clearTimeout(this.heartbeatTimer), this.heartbeatTimer = undefined);
  }
  ensureOpen() {
    if (this.invalidatedReason !== undefined)
      throw new u(`The Quack server invalidated its database and must be restarted: ${this.invalidatedReason}`);
    if (this.closed || !this.connectionId)
      throw new u("Quack client is not connected");
  }
  getConnectionId() {
    return this.ensureOpen(), this.connectionId;
  }
  allocateQueryId() {
    return this.nextQueryId++;
  }
};
function Xn(e, n) {
  let r = e.trim();
  if (!r)
    throw new u("Quack URI is empty");
  if (r.startsWith("http://") || r.startsWith("https://")) {
    let e = new URL(r), t = e.protocol === "https:";
    return {
      baseUrl: `${e.protocol}//${e.host}`,
      host: e.hostname,
      port: e.port ? Number(e.port) : t ? 443 : 80,
      ssl: t
    };
  }
  let i = r;
  if (i.startsWith("quack://") ? i = i.slice(8) : i.startsWith("quack:") && (i = i.slice(6)), !i)
    throw new u(`Invalid Quack URI ${e}`);
  let { host: a, port: o } = Qn(i), s = n ?? !Zn(a);
  return {
    baseUrl: `${s ? "https" : "http"}://${a.includes(":") && !a.startsWith("[") ? `[${a}]` : a}:${o}`,
    host: a,
    port: o,
    ssl: s
  };
}
function Zn(e) {
  return e.toLowerCase() === "localhost" || e === "127.0.0.1" || e === "::1";
}
function Qn(e) {
  if (e.startsWith("[")) {
    let n = e.indexOf("]");
    if (n < 0)
      throw new u(`Invalid IPv6 Quack URI host ${e}`);
    let r = e.slice(1, n), i = e.slice(n + 1);
    return {
      host: r,
      port: i.startsWith(":") ? $n(i.slice(1)) : t
    };
  }
  let n = [...e].filter((e) => e === ":").length;
  if (n === 0)
    return {
      host: e,
      port: t
    };
  if (n === 1) {
    let [n, r] = e.split(":");
    if (!n)
      throw new u(`Invalid Quack URI host ${e}`);
    return {
      host: n,
      port: $n(r ?? "")
    };
  }
  throw new u(`IPv6 Quack URI hosts must be enclosed in []: ${e}`);
}
function $n(e) {
  let n = Number(e);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new u(`Invalid Quack URI port ${e}`);
  return n;
}
function er() {
  return globalThis.navigator?.userAgent ?? "quack-ts";
}
function tr(e) {
  let n = BigInt(e);
  if (typeof e == "number" && !Number.isInteger(e))
    throw new u("heartbeatTimeoutSeconds must be an integer");
  if (n < 1n || n > s || n > BigInt(2 ** 53 - 1))
    throw new u(`heartbeatTimeoutSeconds must be between 1 and ${2 ** 53 - 1}`);
  return Number(n);
}
function X2(e, n) {
  if (e.type !== n)
    throw new u(`Expected ${J[n]}, got ${J[e.type] ?? e.type}`);
  return e;
}
function Z2(e, t) {
  return e.map((e) => ({
    ...e,
    columnNames: [...t]
  }));
}
function nr(e) {
  return Array.isArray(e);
}
function rr(e) {
  let t = [], n = [], r = 0;
  for (let i of e)
    for (let e = 0;e < i.rowCount; e += c) {
      let a = ir(i, e, Math.min(i.rowCount, e + c));
      r + a.rowCount > Jn && n.length > 0 && (t.push(n), n = [], r = 0), n.push(a), r += a.rowCount;
    }
  return n.length > 0 && t.push(n), t;
}
function ir(e, t, n) {
  return t === 0 && n === e.rowCount ? e : {
    ...e,
    rowCount: n - t,
    columns: e.columns.map((e) => ({
      ...e,
      values: e.values.slice(t, n)
    }))
  };
}
function ar(e) {
  let t = new Uint8Array(e), n = globalThis.crypto;
  if (n?.getRandomValues)
    n.getRandomValues(t);
  else
    for (let n = 0;n < e; n++)
      t[n] = Math.floor(Math.random() * 256);
  return t;
}
function or() {
  for (;; ) {
    let e = new DataView(ar(16).buffer), t = e.getBigInt64(0, true), n = e.getBigUint64(8, true);
    if (t !== 0n || n !== 0n)
      return {
        upper: t,
        lower: n
      };
  }
}
function sr() {
  return [...ar(16)].map((e) => e.toString(16).padStart(2, "0")).join("");
}
function cr(e) {
  let t = e;
  typeof t == "object" && typeof t.unref == "function" && t.unref();
}
function Q2(e, t) {
  return e === undefined ? t ? { ...t } : {} : Array.isArray(e) ? {
    ...t,
    params: e
  } : ur(e) ? {
    ...e,
    ...t
  } : {
    ...t,
    params: e
  };
}
function $2(e, t) {
  if (e === undefined)
    return t ? {
      ...t,
      params: t.params
    } : { params: undefined };
  if (Array.isArray(e))
    return {
      ...t,
      params: e
    };
  if (lr(e)) {
    let n = {
      ...e,
      ...t
    };
    return {
      ...n,
      params: n.params
    };
  }
  return {
    ...t,
    params: e
  };
}
function lr(e) {
  return ur(e) || "useDate" in e || "useDecimalInt" in e || "useBigInt" in e || "useBigIntTimestamp" in e || "useMap" in e || "useProxy" in e || "useGeoJSON" in e || "duckTypes" in e || "format" in e || "codec" in e;
}
function ur(e) {
  return "params" in e || "signal" in e || "timeoutMs" in e || "inlineRows" in e;
}
function dr(e, n) {
  let r = typeof e == "string" ? { table: e } : e, i = typeof n == "string" ? {} : n ?? {}, a = typeof n == "string" ? n : i.schema ?? r.schema;
  if (!r.table)
    throw new u("append requires a table name");
  return {
    target: [
      ...r.catalog === undefined ? [] : [r.catalog],
      ...a === undefined ? [] : [a],
      r.table
    ].map(q2).join("."),
    options: {
      ...i.signal === undefined ? {} : { signal: i.signal },
      ...i.timeoutMs === undefined ? {} : { timeoutMs: i.timeoutMs }
    }
  };
}
function fr(e) {
  if (e.timeoutMs === undefined)
    return {
      ...e.signal === undefined ? {} : { signal: e.signal },
      cleanup: () => {
        return;
      }
    };
  if (e.timeoutMs < 1)
    throw new u("timeoutMs must be at least 1");
  let n = new AbortController, r = () => n.abort(e.signal?.reason), i = setTimeout(() => n.abort(/* @__PURE__ */ Error(`Quack request timed out after ${e.timeoutMs}ms`)), e.timeoutMs);
  return e.signal && (e.signal.aborted ? n.abort(e.signal.reason) : e.signal.addEventListener("abort", r, { once: true })), {
    signal: n.signal,
    cleanup: () => {
      clearTimeout(i), e.signal?.removeEventListener("abort", r);
    }
  };
}

// src/client/app.ts
var SAMPLES = [
  {
    role: "analyst",
    label: "Analyst: full table",
    sql: "SELECT region, product, units, revenue, customer FROM orders"
  },
  {
    role: "viewer",
    label: "Viewer: mask and filter",
    sql: "SELECT region, product, revenue, customer FROM orders"
  },
  {
    role: "guest",
    label: "Guest: blocked columns",
    sql: "SELECT customer, revenue FROM orders"
  }
];
var sqlBox = document.querySelector("#sql");
var form = document.querySelector("#form");
var run = document.querySelector("#run");
var status = document.querySelector("#status");
var explainEl = document.querySelector("#explain");
var rowsEl = document.querySelector("#rows");
var mapEl = document.querySelector("#map");
var snippetEl = document.querySelector("#snippet");
var copyBtn = document.querySelector("#copy");
var chips = document.querySelector("#chips");
var roles = document.querySelectorAll(".role");
var role = "analyst";
var siteKey = "0x4AAAAAAFRUoj5qDpf7XyIW";
var widgetId = "";
var turnstileToken = "";
var snippet = "";
function setStatus(text) {
  if (status)
    status.textContent = text;
}
function selectRole(next) {
  role = next;
  roles.forEach((button) => {
    const on = button.dataset.role === next;
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });
}
document.querySelector("#theme")?.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem("theme", next);
  } catch {}
});
roles.forEach((button) => {
  button.addEventListener("click", () => {
    const next = button.dataset.role;
    if (next === "analyst" || next === "viewer" || next === "guest")
      selectRole(next);
  });
});
SAMPLES.forEach((sample) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip";
  button.textContent = sample.label;
  button.addEventListener("click", () => {
    selectRole(sample.role);
    if (sqlBox)
      sqlBox.value = sample.sql;
    sqlBox?.focus();
  });
  chips?.append(button);
});
function renderExplain(explain, fallback) {
  if (!explainEl)
    return;
  explainEl.replaceChildren();
  if (!explain) {
    explainEl.dataset.effect = "";
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = fallback;
    explainEl.append(p);
    return;
  }
  explainEl.dataset.effect = explain.effect;
  const badge = document.createElement("p");
  badge.className = `badge badge-${explain.effect}`;
  badge.textContent = explain.effect;
  const list = document.createElement("ul");
  explain.reasons.forEach((reason) => {
    const item = document.createElement("li");
    item.textContent = reason;
    list.append(item);
  });
  explainEl.append(badge, list);
  if (explain.executedSql) {
    const label = document.createElement("p");
    label.className = "eyebrow";
    label.textContent = "SQL that ran";
    const code = document.createElement("pre");
    code.className = "code";
    code.textContent = explain.executedSql;
    explainEl.append(label, code);
  }
}
function renderRows(names, records) {
  if (!rowsEl)
    return;
  rowsEl.replaceChildren();
  if (!records.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = names.length ? "The statement returned no rows." : "No rows were returned.";
    rowsEl.append(p);
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  const head = document.createElement("tr");
  names.forEach((name) => {
    const cell = document.createElement("th");
    cell.textContent = name;
    head.append(cell);
  });
  const thead = document.createElement("thead");
  thead.append(head);
  const tbody = document.createElement("tbody");
  records.forEach((record) => {
    const tr = document.createElement("tr");
    names.forEach((name) => {
      const cell = document.createElement("td");
      const value = record[name];
      if (value === null || value === undefined) {
        cell.textContent = "null";
        cell.className = "nil";
      } else {
        cell.textContent = String(value);
      }
      tr.append(cell);
    });
    tbody.append(tr);
  });
  table.append(thead, tbody);
  wrap.append(table);
  const count = document.createElement("p");
  count.className = "muted";
  count.textContent = `${records.length} row${records.length === 1 ? "" : "s"}`;
  rowsEl.append(wrap, count);
}
function renderMap(payload) {
  if (!mapEl)
    return;
  mapEl.replaceChildren();
  const registry = document.createElement("p");
  registry.className = "mono";
  const k = document.createElement("span");
  k.className = "eyebrow";
  k.textContent = "Registry";
  registry.append(k, document.createTextNode(` ${payload.registryId}`));
  mapEl.append(registry);
  payload.catalogs.forEach((catalog) => {
    const card = document.createElement("article");
    card.className = "docard";
    const title = document.createElement("h3");
    title.textContent = catalog.id;
    const id = document.createElement("p");
    id.className = "mono";
    id.textContent = catalog.durableObjectId;
    const path = document.createElement("p");
    path.className = "mono";
    path.textContent = catalog.dataPath;
    const meta = document.createElement("p");
    meta.className = "muted";
    meta.textContent = `${catalog.rows} rows · parquet ${catalog.parquet ? "in R2" : "not written yet"}`;
    card.append(title, id, path, meta);
    mapEl.append(card);
  });
}
function showSnippet(text) {
  snippet = text;
  if (!snippetEl)
    return;
  snippetEl.textContent = text || "Run a query to mint a ten-minute read-only token.";
}
copyBtn?.addEventListener("click", () => {
  if (!snippet)
    return;
  navigator.clipboard.writeText(snippet).then(() => setStatus("The DuckDB snippet is on the clipboard."), () => setStatus("The clipboard was blocked. Select the snippet and copy it."));
});
function mountTurnstile() {
  const host = document.getElementById("turnstile");
  const api = window.turnstile;
  if (!host || host.dataset.ready === "1")
    return true;
  if (!api || typeof api.render !== "function")
    return false;
  host.dataset.ready = "1";
  widgetId = api.render(host, {
    sitekey: siteKey,
    callback: (token) => {
      turnstileToken = token;
      setStatus("Check passed. Pick a role and run a query.");
    },
    "error-callback": () => {
      turnstileToken = "";
      setStatus("The check failed. Reload and try again.");
    },
    "expired-callback": () => {
      turnstileToken = "";
    }
  });
  return true;
}
async function loadMap() {
  const response = await fetch("/api/map");
  if (!response.ok) {
    setStatus("The catalog map is unavailable.");
    return;
  }
  renderMap(await response.json());
}
async function boot() {
  try {
    const response = await fetch("/api/config");
    if (response.ok) {
      const body = await response.json();
      if (body.siteKey)
        siteKey = body.siteKey;
    }
  } catch {}
  const timer = window.setInterval(() => {
    if (mountTurnstile())
      window.clearInterval(timer);
  }, 200);
  window.setTimeout(() => window.clearInterval(timer), 8000);
  await loadMap();
}
form?.addEventListener("submit", (event) => {
  event.preventDefault();
  runQuery();
});
async function runQuery() {
  if (!sqlBox || !run)
    return;
  const statement = sqlBox.value.trim();
  if (!statement) {
    setStatus("Write a SELECT first.");
    return;
  }
  if (!turnstileToken) {
    setStatus("Finish the check above the button first.");
    return;
  }
  run.disabled = true;
  setStatus("Minting a ten-minute token…");
  renderExplain(null, "Waiting for the catalog.");
  try {
    const minted = await fetch("/api/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role, turnstile: turnstileToken, catalog: "orders" })
    });
    const mintedBody = await minted.json();
    if (!minted.ok || !mintedBody.token) {
      setStatus(mintedBody.error || "The token was not issued.");
      return;
    }
    showSnippet(mintedBody.snippet || "");
    setStatus("Running the statement over Quack…");
    const captured = { explain: null, httpError: "" };
    const client = await Yn.connect(location.origin, {
      authToken: mintedBody.token,
      heartbeat: false,
      clientPlatform: "lake-catalog-browser",
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        const header = response.headers.get("x-lake-explain");
        if (header) {
          try {
            captured.explain = JSON.parse(header);
          } catch {
            captured.explain = null;
          }
        }
        if (!response.ok)
          captured.httpError = await response.clone().text();
        return response;
      }
    });
    try {
      const result = await client.query(statement);
      const records = result.rows();
      renderRows(result.names, records);
      renderExplain(captured.explain, "The catalog returned rows without an explain header.");
      const effect = captured.explain?.effect ?? "done";
      setStatus(`Decision: ${effect}. The log stores the role and the decision, not the SQL.`);
    } catch (err) {
      renderRows([], []);
      renderExplain(captured.explain, captured.httpError || (err instanceof Error ? err.message : "The query failed."));
      const effect = captured.explain?.effect;
      setStatus(effect ? `Decision: ${effect}.` : captured.httpError || (err instanceof Error ? err.message : "The query failed."));
    } finally {
      await client.disconnect().catch(() => {
        return;
      });
    }
    const api = window.turnstile;
    if (widgetId && api?.reset)
      api.reset(widgetId);
    turnstileToken = "";
  } finally {
    run.disabled = false;
  }
}
boot();

(() => {
  "use strict";
  // AT1 is a frozen wire protocol, NOT the extension version.
  // Never change its field order, defaults, ranges or scaling. Add a new
  // protocol version for incompatible changes and keep this decoder.
  const PREFIX = "AT1.";
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const MAX_TOKEN = 512;
  const MAX_JSON = 16384;
  const JSON_SCHEMA = 1;
  const fields = [
    ["speed", "medium", ["slow","medium","fast"]],
    ["advancedMode", false],
    ["cpm", 300, 30, 1800],
    ["jitter", 18, 0, 90],
    ["punctuationMs", 220, 0, 3000],
    ["newlineMs", 400, 0, 5000],
    ["rest", false],
    ["restMinChars", 80, 5, 10000],
    ["restMaxChars", 150, 5, 10000],
    ["restMinMs", 900, 0, 60000],
    ["restMaxMs", 2300, 0, 60000],
    ["microChance", 3, 0, 100],
    ["microMinMs", 150, 0, 10000],
    ["microMaxMs", 600, 0, 10000],
    ["startDelay", 1, 0, 15, 2],
    ["mode", "auto", ["auto","iframe","cdp"]],
    ["enterStrategy", "keydown", ["keydown","keypress","both"]],
    ["typo", false],
    ["fixTypo", false],
    ["deepRest", false],
    ["typoChance", 1.5, 0, 35, 2],
    ["fixChance", 3, 0, 35, 2],
    ["fixPauseMs", 400, 0, 3000],
    ["deepRestAt", "both", ["both","word","sentence"]],
    ["deepChance", 14, 0, 100],
    ["deepMinMs", 1300, 0, 120000],
    ["deepMaxMs", 3600, 0, 120000],
    ["keyboardLock", false],
    ["mouseLock", false],
    ["showOverlay", true]
  ].map(([key, def, minOrValues, max, scale = 1]) => {
    if (typeof def === "boolean") return {key, def, kind:"bool", width:1};
    if (Array.isArray(minOrValues)) return {key, def, kind:"enum", values:minOrValues, width:2};
    const min = minOrValues;
    const limit = (max-min)*scale;
    // Reserve the all-ones value for an exact IEEE-754 float64 escape.
    // Normal integer/half-step values remain compact.
    const width = Math.ceil(Math.log2(limit+2));
    return {key, def, kind:"num", min, max, scale, limit, width, escape:2**width-1};
  });
  const wireDefaults = Object.freeze(Object.fromEntries(fields.map(f => [f.key, f.def])));
  function invalid() { return new Error("Invalid or damaged configuration token."); }
  function check(f, value) {
    if (f.kind === "bool") return typeof value === "boolean";
    if (f.kind === "enum") return f.values.includes(value);
    return typeof value === "number" && Number.isFinite(value) &&
      value >= f.min && value <= f.max;
  }
  function normalize(settings) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings))
      throw new Error("Invalid configuration.");
    const clean = {};
    for (const f of fields) {
      const value = Object.prototype.hasOwnProperty.call(settings, f.key) ? settings[f.key] : f.def;
      if (!check(f, value)) throw new Error("Invalid setting: " + f.key + ".");
      // -0 has no meaningful distinction in the typing UI.
      clean[f.key] = Object.is(value, -0) ? 0 : value;
    }
    return clean;
  }

  class Writer {
    constructor() { this.bytes = []; this.bit = 0; }
    put(value, width) {
      for (let i=width-1; i>=0; i--) {
        if (this.bit%8 === 0) this.bytes.push(0);
        this.bytes[this.bytes.length-1] |= ((value >>> i)&1) << (7-this.bit%8);
        this.bit++;
      }
    }
  }
  class Reader {
    constructor(bytes) {this.bytes=bytes;this.bit=0;}
    get(width) {
      if (this.bit+width > this.bytes.length*8) throw invalid();
      let v=0;
      for (let i=0;i<width;i++,this.bit++)
        v=v*2+((this.bytes[this.bit>>3]>>(7-this.bit%8))&1);
      return v;
    }
    finish() {
      const remaining=this.bytes.length*8-this.bit;
      if (remaining>=8 || this.get(remaining)!==0) throw invalid();
    }
  }
  function putValue(writer, f, value) {
    if (f.kind==="bool") return writer.put(Number(value),1);
    if (f.kind==="enum") return writer.put(f.values.indexOf(value),f.width);
    const n=(value-f.min)*f.scale;
    if (Number.isInteger(n) && n>=0 && n<=f.limit && f.min+n/f.scale===value)
      return writer.put(n,f.width);
    writer.put(f.escape,f.width);
    const data=new DataView(new ArrayBuffer(8));
    data.setFloat64(0,value,false);
    for(let i=0;i<8;i++) writer.put(data.getUint8(i),8);
  }
  function getValue(reader, f) {
    const n=reader.get(f.width);
    let value;
    if(f.kind==="bool") value=Boolean(n);
    else if(f.kind==="enum") value=f.values[n];
    else if(n===f.escape) {
      const data=new DataView(new ArrayBuffer(8));
      for(let i=0;i<8;i++) data.setUint8(i,reader.get(8));
      value=data.getFloat64(0,false);
    } else {
      if(n>f.limit) throw invalid();
      value=f.min+n/f.scale;
    }
    if(!check(f,value)) throw invalid();
    return Object.is(value,-0)?0:value;
  }

  // CRC-16/CCITT-FALSE. Detects accidental corruption; not authentication.
  function crc16(bytes) {
    let crc=0xffff;
    for(const byte of bytes) {
      crc^=byte<<8;
      for(let i=0;i<8;i++) crc=((crc&0x8000)?(crc<<1)^0x1021:crc<<1)&0xffff;
    }
    return crc;
  }
  function b64(bytes) {
    let out="", bits=0, value=0;
    for(const byte of bytes) {
      value=(value<<8)|byte; bits+=8;
      while(bits>=6) {bits-=6; out+=ALPHABET[(value>>bits)&63];}
      value&=(1<<bits)-1;
    }
    if(bits) out+=ALPHABET[(value<<(6-bits))&63];
    return out;
  }
  function unb64(value) {
    if(!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length%4===1) throw invalid();
    const out=[];
    let acc=0,bits=0;
    for(const c of value) {
      acc=(acc<<6)|ALPHABET.indexOf(c); bits+=6;
      if(bits>=8) {bits-=8;out.push((acc>>bits)&255);}
      acc&=(1<<bits)-1;
    }
    if(acc!==0 || b64(out)!==value) throw invalid();
    return out;
  }
  function seal(bytes) {
    const crc=crc16(bytes);
    return PREFIX+b64([...bytes,crc>>8,crc&255]);
  }

  function encode(settings) {
    const clean=normalize(settings);
    const changed=fields.map((f,i)=>({f,i})).filter(({f})=>clean[f.key]!==f.def);
    // Sparse: 1 mode bit, 5 count bits, sorted 5-bit field IDs.
    // A changed boolean needs no extra bit: it is the complement of default.
    const sparse=new Writer();
    sparse.put(0,1);sparse.put(changed.length,5);
    for(const {f,i} of changed) {
      sparse.put(i,5);
      if(f.kind!=="bool") putValue(sparse,f,clean[f.key]);
    }
    // Dense: 1 mode bit, packed fields in schema order. Compare final
    // base64url lengths rather than raw values; pick sparse on a tie.
    const dense=new Writer();
    dense.put(1,1);
    for(const f of fields) putValue(dense,f,clean[f.key]);
    const a=seal(sparse.bytes),b=seal(dense.bytes);
    return a.length<=b.length?a:b;
  }
  function decode(raw) {
    if(typeof raw!=="string") throw invalid();
    if(raw.length>MAX_TOKEN+32) throw invalid();
    const token=raw.trim();
    if(token.length>MAX_TOKEN) throw invalid();
    if(!token.startsWith(PREFIX)) {
      if(/^AT\d+\./.test(token)) throw new Error("Unsupported configuration version.");
      throw invalid();
    }
    const bytes=unb64(token.slice(PREFIX.length));
    if(bytes.length<3) throw invalid();
    const expected=(bytes[bytes.length-2]<<8)|bytes[bytes.length-1];
    const body=bytes.slice(0,-2);
    if(crc16(body)!==expected) throw invalid();
    const reader=new Reader(body);
    const clean={...wireDefaults};
    if(reader.get(1)) {
      for(const f of fields) clean[f.key]=getValue(reader,f);
    } else {
      const count=reader.get(5);
      if(count>fields.length) throw invalid();
      let previous=-1;
      for(let i=0;i<count;i++) {
        const index=reader.get(5);
        if(index<=previous || index>=fields.length) throw invalid();
        previous=index;
        const f=fields[index];
        const value=f.kind==="bool"?!f.def:getValue(reader,f);
        if(value===f.def) throw invalid();
        clean[f.key]=value;
      }
    }
    reader.finish();
    return clean;
  }
  // JSON uses the same frozen v1 defaults and validation as AT1.
  // Strict imports reject misspelled/unknown fields rather than quietly
  // resetting those settings to defaults. Exports whitelist the schema.
  function encodeJSON(settings) {
    return JSON.stringify({schemaVersion:JSON_SCHEMA, settings:normalize(settings)}, null, 2);
  }
  function decodeJSON(raw) {
    if(typeof raw!=="string" || raw.length>MAX_JSON)
      throw new Error("JSON configuration must be at most 16 KB of text.");
    let data;
    try { data=JSON.parse(raw.trim()); }
    catch { throw new Error("Invalid configuration JSON."); }
    const object = value => value!==null && typeof value==="object" && !Array.isArray(value);
    const own = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
    if(!object(data)) throw new Error("Configuration JSON must be an object.");
    let settings=data;
    if(own(data,"schemaVersion") || own(data,"settings")) {
      if(data.schemaVersion!==JSON_SCHEMA)
        throw new Error("Unsupported JSON configuration version.");
      if(Object.keys(data).some(key=>key!=="schemaVersion" && key!=="settings"))
        throw new Error("Unknown JSON configuration metadata.");
      if(!own(data,"settings") || !object(data.settings))
        throw new Error("JSON configuration must contain a settings object.");
      settings=data.settings;
    }
    const keys=Object.keys(settings);
    if(!keys.length) throw new Error("JSON configuration has no settings.");
    for(const key of keys) {
      if(!own(wireDefaults,key)) throw new Error("Unknown configuration setting: "+key+".");
    }
    return normalize(settings);
  }
  function decodeAny(raw) {
    if(typeof raw!=="string" || raw.length>MAX_JSON)
      throw new Error("Configuration is too large or invalid.");
    const value=raw.trim();
    return /^[{\[]/.test(value) ? decodeJSON(raw) : decode(raw);
  }
  // Only explicit schema fields are ever encoded. No drafts, URLs, IDs,
  // browser data or arbitrary properties are included.
  globalThis.AutoTypeConfig = Object.freeze({
    encode, decode, encodeJSON, decodeJSON, decodeAny,
    defaults:wireDefaults, maxToken:MAX_TOKEN, maxJSON:MAX_JSON
  });
})();

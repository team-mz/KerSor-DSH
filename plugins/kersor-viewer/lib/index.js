import path from "node:path";
import { Service } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { execFile } from "node:child_process";
import { access, open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { watch } from "node:fs";
//#region ../../../vendor/cosmokit/src/misc.ts
/** Return true when a value is `null` or `undefined`. */
function isNullable(value) {
	return value === null || value === void 0;
}
/** Return true for non-array object values. */
function isPlainObject(data) {
	return data && typeof data === "object" && !Array.isArray(data);
}
/** Filter object entries and return a new object. */
function filterKeys(object, filter) {
	return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
/** Map object values while preserving the original key set. */
function mapValues(object, transform) {
	return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
/** Pick selected keys from an object, optionally including `undefined` values. */
function pick(source, keys, forced) {
	if (!keys) return { ...source };
	const result = {};
	for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
	return result;
}
//#endregion
//#region ../../../vendor/cosmokit/src/types.ts
/** Test values using `instanceof` with a `toStringTag` fallback. */
function is(type, value) {
	if (arguments.length === 1) return (value) => is(type, value);
	return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
	return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
	return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
let Binary;
(function(_Binary) {
	_Binary.is = isArrayBufferLike;
	_Binary.isSource = isArrayBufferSource;
	function fromSource(source) {
		if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
		else return source;
	}
	_Binary.fromSource = fromSource;
	function toBase64(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
		let binary = "";
		const bytes = new Uint8Array(source);
		for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
		return btoa(binary);
	}
	_Binary.toBase64 = toBase64;
	function fromBase64(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
		return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
	}
	_Binary.fromBase64 = fromBase64;
	function toHex(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
		return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	_Binary.toHex = toHex;
	function fromHex(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
		const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
		const buffer = [];
		for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
		return Uint8Array.from(buffer).buffer;
	}
	_Binary.fromHex = fromHex;
})(Binary || (Binary = {}));
Binary.fromBase64;
Binary.toBase64;
Binary.fromHex;
Binary.toHex;
/** Deep-clone common JavaScript values while preserving prototypes and cycles. */
function clone(source, refs = /* @__PURE__ */ new Map()) {
	if (!source || typeof source !== "object") return source;
	if (is("Date", source)) return new Date(source.valueOf());
	if (is("RegExp", source)) return new RegExp(source.source, source.flags);
	if (isArrayBufferLike(source)) return source.slice(0);
	if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
	const cached = refs.get(source);
	if (cached) return cached;
	if (Array.isArray(source)) {
		const result = [];
		refs.set(source, result);
		source.forEach((value, index) => {
			result[index] = Reflect.apply(clone, null, [value, refs]);
		});
		return result;
	}
	const result = Object.create(Object.getPrototypeOf(source));
	refs.set(source, result);
	for (const key of Reflect.ownKeys(source)) {
		const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
		if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
		Reflect.defineProperty(result, key, descriptor);
	}
	return result;
}
/** Deeply compare arrays, dates, regexps, buffers, and plain object fields. */
function deepEqual(a, b, strict) {
	if (a === b) return true;
	if (!strict && isNullable(a) && isNullable(b)) return true;
	if (typeof a !== typeof b) return false;
	if (typeof a !== "object") return false;
	if (!a || !b) return false;
	function check(test, then) {
		return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
	}
	return check(Array.isArray, (a, b) => a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))) ?? check(is("Date"), (a, b) => a.valueOf() === b.valueOf()) ?? check(is("RegExp"), (a, b) => a.source === b.source && a.flags === b.flags) ?? check(isArrayBufferLike, (a, b) => {
		if (a.byteLength !== b.byteLength) return false;
		const viewA = new Uint8Array(a);
		const viewB = new Uint8Array(b);
		for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
		return true;
	}) ?? Object.keys({
		...a,
		...b
	}).every((key) => deepEqual(a[key], b[key], strict));
}
//#endregion
//#region ../../../vendor/cosmokit/src/time.ts
let Time;
(function(_Time) {
	_Time.millisecond = 1;
	const second = _Time.second = 1e3;
	const minute = _Time.minute = second * 60;
	const hour = _Time.hour = minute * 60;
	const day = _Time.day = hour * 24;
	const week = _Time.week = day * 7;
	let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
	function setTimezoneOffset(offset) {
		timezoneOffset = offset;
	}
	_Time.setTimezoneOffset = setTimezoneOffset;
	function getTimezoneOffset() {
		return timezoneOffset;
	}
	_Time.getTimezoneOffset = getTimezoneOffset;
	function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
		if (typeof date === "number") date = new Date(date);
		if (offset === void 0) offset = timezoneOffset;
		return Math.floor((date.valueOf() / minute - offset) / 1440);
	}
	_Time.getDateNumber = getDateNumber;
	function fromDateNumber(value, offset) {
		const date = new Date(value * day);
		if (offset === void 0) offset = timezoneOffset;
		return new Date(+date + offset * minute);
	}
	_Time.fromDateNumber = fromDateNumber;
	const numeric = /\d+(?:\.\d+)?/.source;
	const timeRegExp = new RegExp(`^${[
		"w(?:eek(?:s)?)?",
		"d(?:ay(?:s)?)?",
		"h(?:our(?:s)?)?",
		"m(?:in(?:ute)?(?:s)?)?",
		"s(?:ec(?:ond)?(?:s)?)?"
	].map((unit) => `(${numeric}${unit})?`).join("")}$`);
	function parseTime(source) {
		const capture = timeRegExp.exec(source);
		if (!capture) return 0;
		return (parseFloat(capture[1]) * week || 0) + (parseFloat(capture[2]) * day || 0) + (parseFloat(capture[3]) * hour || 0) + (parseFloat(capture[4]) * minute || 0) + (parseFloat(capture[5]) * second || 0);
	}
	_Time.parseTime = parseTime;
	function parseDate(date) {
		const parsed = parseTime(date);
		if (parsed) date = Date.now() + parsed;
		else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
		else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
		return date ? new Date(date) : /* @__PURE__ */ new Date();
	}
	_Time.parseDate = parseDate;
	function format(ms) {
		const abs = Math.abs(ms);
		if (abs >= day - hour / 2) return Math.round(ms / day) + "d";
		else if (abs >= hour - minute / 2) return Math.round(ms / hour) + "h";
		else if (abs >= minute - second / 2) return Math.round(ms / minute) + "m";
		else if (abs >= second) return Math.round(ms / second) + "s";
		return ms + "ms";
	}
	_Time.format = format;
	function toDigits(source, length = 2) {
		return source.toString().padStart(length, "0");
	}
	_Time.toDigits = toDigits;
	function template(template, time = /* @__PURE__ */ new Date()) {
		return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
	}
	_Time.template = template;
})(Time || (Time = {}));
//#endregion
//#region ../../../vendor/schemastery/src/index.ts
const kSchema = Symbol.for("schemastery");
const kValidationError = Symbol.for("ValidationError");
globalThis.__schemastery_index__ ??= 0;
globalThis.__schemastery_refs__ = void 0;
var ValidationError = class extends TypeError {
	options;
	name = "ValidationError";
	constructor(message, options) {
		let prefix = "$";
		for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
		else if (typeof segment === "number") prefix += "[" + segment + "]";
		else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
		if (prefix.startsWith(".")) prefix = prefix.slice(1);
		super((prefix === "$" ? "" : `${prefix} `) + message);
		this.options = options;
	}
	static is(error) {
		return !!error?.[kValidationError];
	}
};
Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
const Schema = function(options) {
	const schema = function(data, options = {}) {
		return Schema.resolve(data, schema, options)[0];
	};
	if (options.refs) {
		const refs = mapValues(options.refs, (options) => new Schema(options));
		const getRef = (uid) => refs[uid];
		for (const key in refs) {
			const options = refs[key];
			options.sKey = getRef(options.sKey);
			options.inner = getRef(options.inner);
			options.list = options.list && options.list.map(getRef);
			options.dict = options.dict && mapValues(options.dict, getRef);
		}
		return refs[options.uid];
	}
	Object.assign(schema, options);
	if (typeof schema.callback === "string") try {
		schema.callback = new Function("return " + schema.callback)();
	} catch {}
	Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
	Object.setPrototypeOf(schema, Schema.prototype);
	schema.meta ||= {};
	schema.toString = schema.toString.bind(schema);
	return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, "~standard", { get() {
	return {
		version: 1,
		vendor: "schemastery",
		validate: (value) => {
			try {
				return { value: Schema.resolve(value, this, {})[0] };
			} catch (error) {
				if (ValidationError.is(error)) return { issues: [{
					message: error.message,
					path: error.options.path
				}] };
				throw error;
			}
		}
	};
} });
Schema.ValidationError = ValidationError;
Schema.prototype.toJSON = function toJSON() {
	if (globalThis.__schemastery_refs__) {
		globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
		return this.uid;
	}
	globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
	globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
	const result = {
		uid: this.uid,
		refs: globalThis.__schemastery_refs__
	};
	globalThis.__schemastery_refs__ = void 0;
	return result;
};
Schema.prototype.set = function set(key, value) {
	this.dict[key] = value;
	return this;
};
Schema.prototype.push = function push(value) {
	this.list.push(value);
	return this;
};
function mergeDesc(original, messages) {
	const result = typeof original === "string" ? { "": original } : { ...original };
	for (const locale in messages) {
		const value = messages[locale];
		if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
		else if (typeof value === "string") result[locale] = value;
	}
	return result;
}
function getInner(value) {
	return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
	return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
}
Schema.prototype.i18n = function i18n(messages) {
	const schema = Schema(this);
	const desc = mergeDesc(schema.meta.description, messages);
	if (Object.keys(desc).length) schema.meta.description = desc;
	if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
		return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
	});
	if (schema.list) schema.list = schema.list.map((inner, index) => {
		return inner.i18n(mapValues(messages, (data = {}) => {
			if (Array.isArray(getInner(data))) return getInner(data)[index];
			if (Array.isArray(data)) return data[index];
			return extractKeys(data);
		}));
	});
	if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
		if (getInner(data)) return getInner(data);
		return extractKeys(data);
	}));
	if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
	return schema;
};
Schema.prototype.extra = function extra(key, value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
};
for (const key of [
	"required",
	"disabled",
	"collapse",
	"hidden",
	"loose"
]) Object.assign(Schema.prototype, { [key](value = true) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
Schema.prototype.deprecated = function deprecated() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "deprecated",
		type: "danger"
	});
	return schema;
};
Schema.prototype.experimental = function experimental() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "experimental",
		type: "warning"
	});
	return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
	const schema = Schema(this);
	const pattern = pick(regexp, ["source", "flags"]);
	schema.meta = {
		...schema.meta,
		pattern
	};
	return schema;
};
Schema.prototype.simplify = function simplify(value) {
	if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
	if (isNullable(value)) return value;
	if (this.type === "object" || this.type === "dict") {
		const result = {};
		for (const key in value) {
			const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
			if (this.type === "dict" || !isNullable(item)) result[key] = item;
		}
		if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
		return result;
	} else if (this.type === "array" || this.type === "tuple") {
		const result = [];
		value.forEach((value, index) => {
			const schema = this.type === "array" ? this.inner : this.list[index];
			const item = schema ? schema.simplify(value) : value;
			result.push(item);
		});
		return result;
	} else if (this.type === "intersect") {
		const result = {};
		for (const item of this.list) Object.assign(result, item.simplify(value));
		return result;
	} else if (this.type === "union") for (const schema of this.list) try {
		Schema.resolve(value, schema, {});
		return schema.simplify(value);
	} catch {}
	return value;
};
Schema.prototype.toString = function toString(inline) {
	return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		role,
		extra
	};
	return schema;
};
for (const key of [
	"default",
	"link",
	"comment",
	"description",
	"max",
	"min",
	"step"
]) Object.assign(Schema.prototype, { [key](value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
const resolvers = {};
Schema.extend = function extend(type, resolve) {
	resolvers[type] = resolve;
};
Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
	if (!schema) return [data];
	if (options.ignore?.(data, schema)) return [data];
	if (isNullable(data) && schema.type !== "lazy") {
		if (schema.meta.required) throw new ValidationError(`missing required value`, options);
		let current = schema;
		let fallback = schema.meta.default;
		while (current?.type === "intersect" && isNullable(fallback)) {
			current = current.list[0];
			fallback = current?.meta.default;
		}
		if (isNullable(fallback)) return [data];
		data = clone(fallback);
	}
	const callback = resolvers[schema.type];
	if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
	try {
		return callback(data, schema, options, strict);
	} catch (error) {
		if (!schema.meta.loose) throw error;
		return [schema.meta.default];
	}
};
Schema.from = function from(source) {
	if (isNullable(source)) return Schema.any();
	else if ([
		"string",
		"number",
		"boolean"
	].includes(typeof source)) return Schema.const(source).required();
	else if (source[kSchema]) return source;
	else if (typeof source === "function") switch (source) {
		case String: return Schema.string().required();
		case Number: return Schema.number().required();
		case Boolean: return Schema.boolean().required();
		case Function: return Schema.function().required();
		default: return Schema.is(source).required();
	}
	else throw new TypeError(`cannot infer schema from ${source}`);
};
Schema.lazy = function lazy(builder) {
	const toJSON = () => {
		if (!schema.inner[kSchema]) {
			schema.inner = schema.builder();
			schema.inner.meta = {
				...schema.meta,
				...schema.inner.meta
			};
		}
		return schema.inner.toJSON();
	};
	const schema = new Schema({
		type: "lazy",
		builder,
		inner: { toJSON }
	});
	return schema;
};
Schema.natural = function natural() {
	return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
	return Schema.number().step(.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
	return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
		const date = new Date(value);
		if (isNaN(+date)) throw new ValidationError(`invalid date "${value}"`, options);
		return date;
	}, true)]);
};
Schema.regExp = function regExp(flag = "") {
	return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
		try {
			return new RegExp(value, flag);
		} catch (e) {
			throw new ValidationError(e.message, options);
		}
	}, true)]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
	return Schema.union([
		Schema.is(ArrayBuffer),
		Schema.is(SharedArrayBuffer),
		Schema.transform(Schema.any(), (value, options) => {
			if (Binary.isSource(value)) return Binary.fromSource(value);
			throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
		}, true),
		...encoding ? [Schema.transform(Schema.string(), (value, options) => {
			try {
				return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
			} catch (e) {
				throw new ValidationError(e.message, options);
			}
		}, true)] : []
	]);
};
Schema.extend("lazy", (data, schema, options, strict) => {
	if (!schema.inner[kSchema]) {
		schema.inner = schema.builder();
		schema.inner.meta = {
			...schema.meta,
			...schema.inner.meta
		};
	}
	return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend("any", (data) => {
	return [data];
});
Schema.extend("never", (data, _, options) => {
	throw new ValidationError(`expected nullable but got ${data}`, options);
});
Schema.extend("const", (data, { value }, options) => {
	if (deepEqual(data, value)) return [value];
	throw new ValidationError(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
	const { max = Infinity, min = -Infinity } = meta;
	if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
	if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend("string", (data, { meta }, options) => {
	if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
	if (meta.pattern) {
		const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
		if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
	}
	checkWithinRange(data.length, meta, "string length", options);
	return [data];
});
function decimalShift(data, digits) {
	const str = data.toString();
	if (str.includes("e")) return data * Math.pow(10, digits);
	const index = str.indexOf(".");
	if (index === -1) return data * Math.pow(10, digits);
	const frac = str.slice(index + 1);
	const integer = str.slice(0, index);
	if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
	return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
	step = Math.abs(step);
	if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
	const index = step.toString().indexOf(".");
	const digits = step.toString().slice(index + 1).length;
	return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend("number", (data, { meta }, options) => {
	if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
	checkWithinRange(data, meta, "number", options);
	const { step } = meta;
	if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
	return [data];
});
Schema.extend("boolean", (data, _, options) => {
	if (typeof data === "boolean") return [data];
	throw new ValidationError(`expected boolean but got ${data}`, options);
});
Schema.extend("bitset", (data, { bits, meta }, options) => {
	let value = 0, keys = [];
	if (typeof data === "number") {
		value = data;
		for (const key in bits) if (data & bits[key]) keys.push(key);
	} else if (Array.isArray(data)) {
		keys = data;
		for (const key of keys) {
			if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
			if (key in bits) value |= bits[key];
		}
	} else throw new ValidationError(`expected number or array but got ${data}`, options);
	if (value === meta.default) return [value];
	return [value, keys];
});
Schema.extend("function", (data, _, options) => {
	if (typeof data === "function") return [data];
	throw new ValidationError(`expected function but got ${data}`, options);
});
Schema.extend("is", (data, { constructor }, options) => {
	if (typeof constructor === "function") {
		if (data instanceof constructor) return [data];
		throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
	} else {
		if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
		let prototype = Object.getPrototypeOf(data);
		while (prototype) {
			if (prototype.constructor?.name === constructor) return [data];
			prototype = Object.getPrototypeOf(prototype);
		}
		throw new ValidationError(`expected ${constructor} but got ${data}`, options);
	}
});
function property(data, key, schema, options) {
	try {
		const [value, adapted] = Schema.resolve(data[key], schema, {
			...options,
			path: [...options.path || [], key]
		});
		if (adapted !== void 0) data[key] = adapted;
		return value;
	} catch (e) {
		if (!options?.autofix) throw e;
		delete data[key];
		return schema.meta.default;
	}
}
Schema.extend("array", (data, { inner, meta }, options) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
	return [data.map((_, index) => property(data, index, inner, options))];
});
Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in data) {
		let rKey;
		try {
			rKey = Schema.resolve(key, sKey, options)[0];
		} catch (error) {
			if (strict) continue;
			throw error;
		}
		result[rKey] = property(data, key, inner, options);
		data[rKey] = data[key];
		if (key !== rKey) delete data[key];
	}
	return [result];
});
Schema.extend("tuple", (data, { list }, options, strict) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	const result = list.map((inner, index) => property(data, index, inner, options));
	if (strict) return [result];
	result.push(...data.slice(list.length));
	return [result];
});
function merge(result, data) {
	for (const key in data) {
		if (key in result) continue;
		result[key] = data[key];
	}
}
Schema.extend("object", (data, { dict }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in dict) {
		const value = property(data, key, dict[key], options);
		if (!isNullable(value) || key in data) result[key] = value;
	}
	if (!strict) merge(result, data);
	return [result];
});
Schema.extend("union", (data, { list, toString }, options, strict) => {
	const messages = [];
	for (const inner of list) try {
		return Schema.resolve(data, inner, options, strict);
	} catch (error) {
		messages.push(error);
	}
	throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString }, options, strict) => {
	if (!list.length) return [data];
	let result;
	for (const inner of list) {
		const value = Schema.resolve(data, inner, options, true)[0];
		if (isNullable(value)) continue;
		if (isNullable(result)) result = value;
		else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
		else if (typeof value === "object") merge(result ??= {}, value);
		else if (result !== value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
	}
	if (!strict && isPlainObject(data)) merge(result, data);
	return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
	const [result, adapted = data] = Schema.resolve(data, inner, options, true);
	if (preserve) return [callback(result)];
	else return [callback(result), callback(adapted)];
});
const formatters = {};
function defineMethod(name, keys, format) {
	formatters[name] = format;
	Object.assign(Schema, { [name](...args) {
		const schema = new Schema({ type: name });
		keys.forEach((key, index) => {
			switch (key) {
				case "sKey":
					schema.sKey = args[index] ?? Schema.string();
					break;
				case "inner":
					schema.inner = Schema.from(args[index]);
					break;
				case "list":
					schema.list = args[index].map(Schema.from);
					break;
				case "dict":
					schema.dict = mapValues(args[index], Schema.from);
					break;
				case "bits":
					schema.bits = {};
					for (const key in args[index]) {
						if (typeof args[index][key] !== "number") continue;
						schema.bits[key] = args[index][key];
					}
					break;
				case "callback": {
					const callback = schema.callback = args[index];
					callback["toJSON"] ||= () => callback.toString();
					break;
				}
				case "constructor": {
					const constructor = schema.constructor = args[index];
					if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
					break;
				}
				default: schema[key] = args[index];
			}
		});
		if (name === "object" || name === "dict") schema.meta.default = {};
		else if (name === "array" || name === "tuple") schema.meta.default = [];
		else if (name === "bitset") schema.meta.default = 0;
		return schema;
	} });
}
defineMethod("is", ["constructor"], ({ constructor }) => {
	if (typeof constructor === "function") return constructor.name;
	else return constructor;
});
defineMethod("any", [], () => "any");
defineMethod("never", [], () => "never");
defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
defineMethod("string", [], () => "string");
defineMethod("number", [], () => "number");
defineMethod("boolean", [], () => "boolean");
defineMethod("bitset", ["bits"], () => "bitset");
defineMethod("function", [], () => "function");
defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
defineMethod("object", ["dict"], ({ dict }) => {
	if (Object.keys(dict).length === 0) return "{}";
	return `{ ${Object.entries(dict).map(([key, inner]) => {
		return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
	}).join(", ")} }`;
});
defineMethod("union", ["list"], ({ list }, inline) => {
	const result = list.map(({ toString: format }) => format()).join(" | ");
	return inline ? `(${result})` : result;
});
defineMethod("intersect", ["list"], ({ list }) => {
	return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
});
defineMethod("transform", [
	"inner",
	"callback",
	"preserve"
], ({ inner }, isInner) => inner.toString(isInner));
//#endregion
//#region lib/types/diagnostics.js
/**
* Bounded, content-free diagnostics shared by KerSor viewer sources.
* @module @deepseek-ai/dsh-kersor-viewer
*/
/**
* Create a safe issue from a runtime failure without retaining its message.
* @param stage - Operation that failed.
* @param error - Untrusted runtime failure to classify without its text.
* @param severity - Stable user-facing impact category.
* @returns Content-free diagnostic safe for the Remote wire.
*/
function issueFromError(stage, error, severity = "error") {
	return createIssue(stage, classifyError(stage, error), severity);
}
/**
* Create a safe issue for a validated failure code.
* @param stage - Operation that failed.
* @param code - Stable failure classification.
* @param severity - Stable user-facing impact category.
* @returns Content-free diagnostic safe for the Remote wire.
*/
function createIssue(stage, code, severity = "error") {
	return {
		stage,
		code,
		severity,
		occurrences: 1,
		lastSeenAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
/**
* Merge repeated identical failures while bounding history to the latest kind.
* @param previous - Previously retained issue, when one exists.
* @param current - Newly observed issue.
* @returns Current issue with an accumulated count only for the same kind.
*/
function mergeIssue(previous, current) {
	if (previous?.stage !== current.stage || previous.code !== current.code) return current;
	return {
		...current,
		occurrences: previous.occurrences + 1
	};
}
/**
* Read a Node-style error code from an unknown exception.
* @param error - Unknown caught value.
* @returns Stringified code, or `undefined` when none is present.
*/
function errorCode(error) {
	return typeof error === "object" && error !== null && "code" in error ? String(error.code) : void 0;
}
function classifyError(stage, error) {
	if (error instanceof SyntaxError) return "invalid_json";
	const code = errorCode(error);
	if (code === "EACCES" || code === "EPERM") return "permission_denied";
	if (code === "ETIMEDOUT") return "timeout";
	if (code === "ENOENT") return stage === "classic_bridge" ? "process_unavailable" : "not_found";
	if (stage === "tailer_watch") return "watch_unavailable";
	if (code !== void 0) return "io_error";
	return "unexpected";
}
//#endregion
//#region lib/types/classic.js
/**
* Read-only adapter from the installed KerSor preset bridge to the viewer.
* @module @deepseek-ai/dsh-kersor-viewer
*/
const execFileAsync = promisify(execFile);
const MAX_CLASSIC_ROUNDS = 100;
function dshHome() {
	const configured = process.env.DSH_HOME?.trim();
	if (!configured) return path.join(homedir(), ".dsh");
	if (configured === "~") return homedir();
	return configured.startsWith("~/") ? path.join(homedir(), configured.slice(2)) : path.resolve(configured);
}
/**
* Resolve the bridge path copied by the portable preset installer.
* @returns Absolute bridge path under the configured DSH home.
*/
function installedBridge() {
	return path.join(dshHome(), ".agent-presets", "kersor", "bin", "kersor_bridge.py");
}
function kersorPython() {
	return process.env.KERSOR_PYTHON?.trim() || "python3";
}
function optionalString$2(value) {
	return value === void 0 || value === null || typeof value === "string";
}
function optionalDetailString(value) {
	return value === void 0 || typeof value === "string";
}
function optionalBoolean(value) {
	return value === void 0 || value === null || typeof value === "boolean";
}
function optionalNumber$2(value) {
	return value === void 0 || value === null || typeof value === "number";
}
function finiteNonNegative(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function optionalFiniteNonNegative(value) {
	return value === void 0 || finiteNonNegative(value);
}
function optionalBoundedString(value, maximum) {
	return value === void 0 || typeof value === "string" && Buffer.byteLength(value) <= maximum;
}
function optionalGate(value) {
	return value === void 0 || value === null || value === "pass" || value === "fail" || value === "pending" || value === "not_required";
}
function optionalBaselineAction(value) {
	return value === void 0 || value === null || value === "init" || value === "record_verify" || value === "new_session";
}
function stringArray(value) {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isClassicArtifact(value) {
	if (value === null || typeof value !== "object") return false;
	const artifact = value;
	return typeof artifact.name === "string" && typeof artifact.sha256 === "string" && typeof artifact.bytes === "number" && Number.isInteger(artifact.bytes) && artifact.bytes >= 0;
}
function isClassicValidationCheck(value) {
	if (value === null || typeof value !== "object") return false;
	const check = value;
	return typeof check.name === "string" && typeof check.passed === "boolean";
}
function isClassicCycleLineage(value) {
	if (value === null || typeof value !== "object") return false;
	const lineage = value;
	const fields = [
		lineage.session_baseline_cycles,
		lineage.best_cycles,
		lineage.session_speedup,
		lineage.task_baseline_cycles,
		lineage.overall_speedup
	];
	return fields.some((field) => field !== void 0) && fields.every(optionalFiniteNonNegative);
}
function isClassicRoundEstimate(value) {
	if (value === null || typeof value !== "object") return false;
	const estimate = value;
	const fields = [estimate.cycles, estimate.speedup];
	return fields.some((field) => field !== void 0) && fields.every(optionalFiniteNonNegative);
}
function isClassicRoundMeasurement(value) {
	if (value === null || typeof value !== "object") return false;
	const measurement = value;
	const fields = [
		measurement.baseline_cycles,
		measurement.candidate_cycles,
		measurement.candidate_speedup,
		measurement.incumbent_cycles,
		measurement.incumbent_speedup,
		measurement.overall_speedup
	];
	return fields.some((field) => field !== void 0) && fields.every(optionalFiniteNonNegative) && (measurement.best_improved === void 0 || typeof measurement.best_improved === "boolean");
}
function isClassicRound(value) {
	if (value === null || typeof value !== "object") return false;
	const round = value;
	if (typeof round.number !== "number" || !Number.isInteger(round.number) || round.number < 1 || !optionalBoundedString(round.workflow, 1024) || !optionalBoundedString(round.candidate_id, 1024) || !optionalBoundedString(round.decision, 8192) || round.workflow_origin !== void 0 && !["catalog", "authored"].includes(round.workflow_origin) || ![
		"pending",
		"pass",
		"fail"
	].includes(round.host_verdict ?? "")) return false;
	if (round.failure_kind !== void 0 && ![
		"correctness",
		"benchmark",
		"infrastructure"
	].includes(round.failure_kind)) return false;
	if (round.estimate !== void 0 && !isClassicRoundEstimate(round.estimate)) return false;
	if (round.measurement !== void 0 && !isClassicRoundMeasurement(round.measurement)) return false;
	if (round.host_verdict !== "pass" && round.measurement !== void 0) return false;
	if (round.host_verdict !== "fail" && round.failure_kind !== void 0) return false;
	return true;
}
function isClassicRounds(value) {
	if (!Array.isArray(value) || value.length > MAX_CLASSIC_ROUNDS || !value.every(isClassicRound)) return false;
	return value.every((round, index) => index === 0 || round.number > (value[index - 1]?.number ?? 0));
}
function isClassicWorkflowPhase(value) {
	if (value === null || typeof value !== "object") return false;
	const phase = value;
	return typeof phase.title === "string" && typeof phase.detail === "string";
}
function isClassicWorkflowDesign(value) {
	if (value === null || typeof value !== "object") return false;
	const design = value;
	return optionalDetailString(design.name) && optionalDetailString(design.description) && optionalDetailString(design.whenToUse) && optionalDetailString(design.technique) && optionalDetailString(design.methodCategory) && optionalDetailString(design.topology) && (design.phases === void 0 || Array.isArray(design.phases) && design.phases.every(isClassicWorkflowPhase)) && stringArray(design.requiredArgs) && stringArray(design.languages) && stringArray(design.backends) && stringArray(design.integrationPatterns) && typeof design.rationale === "string" && typeof design.source === "string";
}
function isClassicSessionDetail(value) {
	if (value === null || typeof value !== "object") return false;
	const detail = value;
	if (typeof detail.session_id !== "string" || typeof detail.session_dir !== "string" || typeof detail.current_round !== "number" || !Number.isInteger(detail.current_round) || detail.current_round < 1 || !Array.isArray(detail.steps)) return false;
	const validStepIds = new Set([
		"setup",
		"baseline",
		"profile",
		"selection",
		"authoring",
		"validation",
		"dispatch",
		"measurement",
		"decision"
	]);
	const validStepStatuses = new Set([
		"pending",
		"active",
		"completed",
		"failed"
	]);
	if (!detail.steps.every((step) => step !== null && typeof step === "object" && validStepIds.has(step.id) && validStepStatuses.has(step.status))) return false;
	const selection = detail.selection;
	if (selection === void 0 || ![
		"pending",
		"stalled",
		"selected"
	].includes(selection.status) || typeof selection.rejectedCount !== "number" || !Number.isInteger(selection.rejectedCount) || selection.rejectedCount < 0 || !optionalDetailString(selection.workflow) || !optionalDetailString(selection.reason)) return false;
	const authoring = detail.authoring;
	if (authoring === void 0 || ![
		"not_started",
		"in_progress",
		"sealed",
		"saved",
		"rejected"
	].includes(authoring.status) || !Array.isArray(authoring.files) || !authoring.files.every(isClassicArtifact)) return false;
	if (authoring.omittedReason !== void 0 && ![
		"too_large",
		"invalid",
		"hash_mismatch"
	].includes(authoring.omittedReason)) return false;
	if (authoring.design !== void 0) {
		if (!isClassicWorkflowDesign(authoring.design)) return false;
	}
	const validation = detail.validation;
	if (validation === void 0 || ![
		"pending",
		"passed",
		"failed"
	].includes(validation.status) || !Array.isArray(validation.checks) || !validation.checks.every(isClassicValidationCheck)) return false;
	if (detail.rounds !== void 0 && !isClassicRounds(detail.rounds)) return false;
	const dispatch = detail.dispatch;
	return dispatch !== void 0 && [
		"pending",
		"preparing",
		"running",
		"completed",
		"failed"
	].includes(dispatch.status) && optionalDetailString(dispatch.runDir) && optionalDetailString(dispatch.runtimeStatus) && (detail.workflow === void 0 || isClassicWorkflowDesign(detail.workflow));
}
function isClassicSession(value) {
	if (value === null || typeof value !== "object") return false;
	const row = value;
	return typeof row.session_id === "string" && typeof row.session_dir === "string" && (row.storage_kind === "v2" || row.storage_kind === "legacy") && (row.lifecycle === "active" || row.lifecycle === "completed" || row.lifecycle === "stalled" || row.lifecycle === "cancelled") && (row.health === "active" || row.health === "stale" || row.health === "needs_resume" || row.health === "terminal" || row.health === "unknown") && (row.status === "terminal-complete" || row.status === "terminal-stalled" || row.status === "terminal-cancelled" || row.status === "resumable" || row.status === "in-progress" || row.status === "pre-round-1") && optionalString$2(row.kernel_language) && optionalString$2(row.backend) && optionalString$2(row.integration_pattern) && optionalBoolean(row.allow_workflow_authoring) && optionalNumber$2(row.workflow_authoring_budget) && optionalNumber$2(row.workflow_authoring_used) && (row.workflow_authoring_used === void 0 || row.workflow_authoring_used === null || Number.isInteger(row.workflow_authoring_used) && row.workflow_authoring_used >= 0) && (row.workflow_authoring_budget === void 0 || row.workflow_authoring_budget === null || row.workflow_authoring_used === void 0 || row.workflow_authoring_used === null || row.workflow_authoring_used <= row.workflow_authoring_budget) && (row.selection_status === void 0 || row.selection_status === null || [
		"pending",
		"stalled",
		"selected"
	].includes(row.selection_status)) && optionalString$2(row.decision) && optionalString$2(row.fit_confidence) && optionalGate(row.baseline_witness) && optionalBaselineAction(row.baseline_next_action) && optionalString$2(row.baseline_reason) && optionalGate(row.profile_evidence) && optionalString$2(row.profile_reason) && optionalString$2(row.profile_owner) && optionalGate(row.dsh_compatibility) && optionalGate(row.candidate_ownership) && optionalGate(row.fresh_session) && (row.stop_reason === void 0 || row.stop_reason === null || [
		"target_met",
		"execution_budget_exhausted",
		"selection_stalled",
		"authoring_budget_exhausted",
		"cancelled",
		"single_run_complete"
	].includes(row.stop_reason)) && (row.cycle_lineage === void 0 || row.cycle_lineage === null || isClassicCycleLineage(row.cycle_lineage)) && Array.isArray(row.warnings) && row.warnings.every((item) => typeof item === "string");
}
function projectCycleLineage(value) {
	return {
		...value.session_baseline_cycles === void 0 ? {} : { session_baseline_cycles: value.session_baseline_cycles },
		...value.best_cycles === void 0 ? {} : { best_cycles: value.best_cycles },
		...value.session_speedup === void 0 ? {} : { session_speedup: value.session_speedup },
		...value.task_baseline_cycles === void 0 ? {} : { task_baseline_cycles: value.task_baseline_cycles },
		...value.overall_speedup === void 0 ? {} : { overall_speedup: value.overall_speedup }
	};
}
function projectClassicRound(row) {
	const estimate = row.estimate === void 0 ? void 0 : {
		...row.estimate.cycles === void 0 ? {} : { cycles: row.estimate.cycles },
		...row.estimate.speedup === void 0 ? {} : { speedup: row.estimate.speedup }
	};
	const measurement = row.measurement === void 0 ? void 0 : {
		...row.measurement.baseline_cycles === void 0 ? {} : { baseline_cycles: row.measurement.baseline_cycles },
		...row.measurement.candidate_cycles === void 0 ? {} : { candidate_cycles: row.measurement.candidate_cycles },
		...row.measurement.candidate_speedup === void 0 ? {} : { candidate_speedup: row.measurement.candidate_speedup },
		...row.measurement.incumbent_cycles === void 0 ? {} : { incumbent_cycles: row.measurement.incumbent_cycles },
		...row.measurement.incumbent_speedup === void 0 ? {} : { incumbent_speedup: row.measurement.incumbent_speedup },
		...row.measurement.best_improved === void 0 ? {} : { best_improved: row.measurement.best_improved },
		...row.measurement.overall_speedup === void 0 ? {} : { overall_speedup: row.measurement.overall_speedup }
	};
	return {
		number: row.number,
		...row.workflow === void 0 ? {} : { workflow: row.workflow },
		...row.workflow_origin === void 0 ? {} : { workflow_origin: row.workflow_origin },
		...row.candidate_id === void 0 ? {} : { candidate_id: row.candidate_id },
		host_verdict: row.host_verdict,
		...row.failure_kind === void 0 ? {} : { failure_kind: row.failure_kind },
		...estimate === void 0 ? {} : { estimate },
		...measurement === void 0 ? {} : { measurement },
		...row.decision === void 0 ? {} : { decision: row.decision }
	};
}
function projectWorkflowDesign(design) {
	return {
		...design.name === void 0 ? {} : { name: design.name },
		...design.description === void 0 ? {} : { description: design.description },
		...design.whenToUse === void 0 ? {} : { whenToUse: design.whenToUse },
		...design.technique === void 0 ? {} : { technique: design.technique },
		...design.methodCategory === void 0 ? {} : { methodCategory: design.methodCategory },
		...design.topology === void 0 ? {} : { topology: design.topology },
		...design.phases === void 0 ? {} : { phases: design.phases.map((phase) => ({
			title: phase.title,
			detail: phase.detail
		})) },
		requiredArgs: [...design.requiredArgs],
		languages: [...design.languages],
		backends: [...design.backends],
		integrationPatterns: [...design.integrationPatterns],
		rationale: design.rationale,
		source: design.source
	};
}
function projectSessionDetail(row) {
	return {
		session_id: row.session_id,
		session_dir: row.session_dir,
		current_round: row.current_round,
		steps: row.steps.map((step) => ({
			id: step.id,
			status: step.status
		})),
		selection: {
			status: row.selection.status,
			...row.selection.workflow === void 0 ? {} : { workflow: row.selection.workflow },
			...row.selection.reason === void 0 ? {} : { reason: row.selection.reason },
			rejectedCount: row.selection.rejectedCount
		},
		authoring: {
			status: row.authoring.status,
			files: row.authoring.files.map((file) => ({
				name: file.name,
				sha256: file.sha256,
				bytes: file.bytes
			})),
			...row.authoring.design === void 0 ? {} : { design: projectWorkflowDesign(row.authoring.design) },
			...row.authoring.omittedReason === void 0 ? {} : { omittedReason: row.authoring.omittedReason }
		},
		validation: {
			status: row.validation.status,
			checks: row.validation.checks.map((check) => ({
				name: check.name,
				passed: check.passed
			}))
		},
		dispatch: {
			status: row.dispatch.status,
			...row.dispatch.runDir === void 0 ? {} : { runDir: row.dispatch.runDir },
			...row.dispatch.runtimeStatus === void 0 ? {} : { runtimeStatus: row.dispatch.runtimeStatus }
		},
		rounds: (row.rounds ?? []).map(projectClassicRound),
		...row.workflow === void 0 ? {} : { workflow: projectWorkflowDesign(row.workflow) }
	};
}
function projectSession(row) {
	return {
		session_id: row.session_id,
		session_dir: row.session_dir,
		storage_kind: row.storage_kind,
		phase: row.phase ?? null,
		lifecycle: row.lifecycle,
		status: row.status,
		health: row.health,
		started_at: row.started_at ?? null,
		last_activity_at: row.last_activity_at ?? null,
		current_round: row.current_round ?? null,
		max_workflows: row.max_workflows ?? null,
		target_speedup: row.target_speedup ?? null,
		target_met: row.target_met ?? null,
		mode: row.mode ?? null,
		backend: row.backend ?? null,
		kernel_language: row.kernel_language ?? null,
		integration_pattern: row.integration_pattern ?? null,
		allow_workflow_authoring: row.allow_workflow_authoring ?? null,
		workflow_authoring_budget: row.workflow_authoring_budget ?? null,
		workflow_authoring_used: row.workflow_authoring_used ?? null,
		kernel_name: row.kernel_name ?? null,
		workflow: row.workflow ?? null,
		selection_status: row.selection_status ?? null,
		decision: row.decision ?? null,
		fit_confidence: row.fit_confidence ?? null,
		baseline_witness: row.baseline_witness ?? null,
		baseline_next_action: row.baseline_next_action ?? null,
		baseline_reason: row.baseline_reason ?? null,
		profile_evidence: row.profile_evidence ?? null,
		profile_reason: row.profile_reason ?? null,
		profile_owner: row.profile_owner ?? null,
		dsh_compatibility: row.dsh_compatibility ?? null,
		candidate_ownership: row.candidate_ownership ?? null,
		fresh_session: row.fresh_session ?? null,
		best_speedup: row.best_speedup ?? null,
		stop_reason: row.stop_reason ?? null,
		cycle_lineage: row.cycle_lineage === void 0 || row.cycle_lineage === null ? null : projectCycleLineage(row.cycle_lineage),
		warningCount: row.warnings.length
	};
}
/**
* Read a sealed, bounded inspector projection for one classic Session.
* @param sessionDir - Exact Session directory already discovered by the Host.
* @returns Valid detail, or `undefined` when the bridge cannot provide it.
*/
async function readClassicSessionDetail(sessionDir) {
	try {
		const { stdout } = await execFileAsync(kersorPython(), [
			installedBridge(),
			"session-detail",
			"--session",
			path.resolve(sessionDir)
		], {
			encoding: "utf8",
			maxBuffer: 2 * 1024 * 1024,
			timeout: 1e4
		});
		const decoded = JSON.parse(stdout);
		return isClassicSessionDetail(decoded) ? projectSessionDetail(decoded) : void 0;
	} catch {
		return;
	}
}
/**
* Invoke the installed bridge without a shell and return a bounded snapshot.
* @param limit - Maximum recent Sessions to retain.
* @param staleAfterSeconds - Advisory unfinished-Session inactivity threshold.
* @param roots - Configured, persisted, and Workspace roots supplied by the Host.
* @returns Valid Session summaries plus structured bridge health.
*/
async function readClassicSessions(limit, staleAfterSeconds = 1800, roots = {}) {
	const bridge = installedBridge();
	try {
		await access(bridge);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return {
			sessions: [],
			source: { state: "not_installed" }
		};
		return {
			sessions: [],
			source: {
				state: "failed",
				lastIssue: issueFromError("classic_bridge", error)
			}
		};
	}
	try {
		const args = [
			bridge,
			"sessions",
			"--limit",
			String(limit),
			"--stale-after",
			String(staleAfterSeconds)
		];
		for (const root of roots.sessionRoots ?? []) if (root.trim()) args.push("--root", root);
		for (const workspace of roots.workspaceRoots ?? []) if (workspace.trim()) args.push("--workspace", workspace);
		if (roots.includeCheckoutRoot === false) args.push("--no-checkout-root");
		const { stdout } = await execFileAsync(kersorPython(), args, {
			encoding: "utf8",
			maxBuffer: 2 * 1024 * 1024,
			timeout: 1e4
		});
		let decoded;
		try {
			decoded = JSON.parse(stdout);
		} catch (error) {
			return {
				sessions: [],
				source: {
					state: "failed",
					lastIssue: issueFromError("classic_bridge", error)
				}
			};
		}
		if (!Array.isArray(decoded.sessions) || !decoded.sessions.every(isClassicSession)) return {
			sessions: [],
			source: {
				state: "failed",
				lastIssue: createIssue("classic_bridge", "invalid_payload")
			}
		};
		const degraded = Array.isArray(decoded.warnings) && decoded.warnings.length > 0;
		return {
			sessions: decoded.sessions.slice(0, limit).map(projectSession),
			source: degraded ? {
				state: "degraded",
				lastIssue: createIssue("classic_bridge", "io_error", "warning")
			} : { state: "healthy" }
		};
	} catch (error) {
		return {
			sessions: [],
			source: {
				state: "failed",
				lastIssue: issueFromError("classic_bridge", error)
			}
		};
	}
}
//#endregion
//#region lib/types/detail.js
/** Bounded projection of one Workflow agent call's retained Codex artifacts. */
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_EVENTS_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 12;
const MAX_ACTIVITIES = 40;
const MAX_MESSAGE_CHARS = 12e3;
const MAX_ACTIVITY_LABEL_CHARS = 500;
function optionalString$1(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
function optionalNumber$1(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function stemOf(call) {
	const label = call.label.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "agent";
	return `${String(call.seq).padStart(5, "0")}-${label}`;
}
async function readBoundedJson(file) {
	try {
		const info = await stat(file);
		if (!info.isFile() || info.size > MAX_RESULT_BYTES) return void 0;
		return record(JSON.parse(await readFile(file, "utf8")));
	} catch {
		return;
	}
}
async function readEventsPrefix(file) {
	let handle;
	try {
		handle = await open(file, "r");
		const buffer = Buffer.alloc(2097153);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const truncated = bytesRead > MAX_EVENTS_BYTES;
		let text = buffer.subarray(0, Math.min(bytesRead, MAX_EVENTS_BYTES)).toString("utf8");
		if (truncated) text = text.slice(0, Math.max(0, text.lastIndexOf("\n")));
		return {
			text,
			truncated
		};
	} catch {
		return { truncated: false };
	} finally {
		await handle?.close();
	}
}
function usageOf(result) {
	const usage = record(result?.usage);
	if (usage === void 0) return void 0;
	const inputTokens = optionalNumber$1(usage.input_tokens);
	const cachedInputTokens = optionalNumber$1(usage.cached_input_tokens);
	const outputTokens = optionalNumber$1(usage.output_tokens);
	const totalTokens = optionalNumber$1(usage.total_tokens);
	if (inputTokens === void 0 && cachedInputTokens === void 0 && outputTokens === void 0 && totalTokens === void 0) return void 0;
	return {
		...inputTokens === void 0 ? {} : { inputTokens },
		...cachedInputTokens === void 0 ? {} : { cachedInputTokens },
		...outputTokens === void 0 ? {} : { outputTokens },
		...totalTokens === void 0 ? {} : { totalTokens }
	};
}
/**
* Read one discovered call's retained worker artifacts without forwarding tool payloads.
* @param runDir - Exact discovered run directory.
* @param call - Call already present in the folded run view.
* @returns Bounded messages and activity names, or `undefined` when no artifacts exist.
*/
async function readCallDetail(runDir, call) {
	const stem = stemOf(call);
	const resultFile = path.join(runDir, ".runtime", "agent-results", `${stem}.json`);
	const eventsFile = path.join(runDir, ".runtime", "agent-results", `${stem}.codex-events.jsonl`);
	const [result, events] = await Promise.all([readBoundedJson(resultFile), readEventsPrefix(eventsFile)]);
	if (result === void 0 && events.text === void 0) return void 0;
	const messages = [];
	const activities = [];
	let truncated = events.truncated;
	for (const line of events.text?.split("\n") ?? []) {
		if (line.length === 0) continue;
		let event;
		try {
			event = record(JSON.parse(line));
		} catch {
			truncated = true;
			continue;
		}
		if (event?.type !== "item.completed") continue;
		const item = record(event.item);
		const id = optionalString$1(item?.id);
		if (item?.type === "agent_message") {
			const text = optionalString$1(item.text);
			if (id === void 0 || text === void 0) continue;
			if (messages.length >= MAX_MESSAGES) {
				truncated = true;
				continue;
			}
			if (text.length > MAX_MESSAGE_CHARS) truncated = true;
			messages.push({
				id,
				text: text.slice(0, MAX_MESSAGE_CHARS)
			});
			continue;
		}
		if (activities.length >= MAX_ACTIVITIES) {
			truncated = true;
			continue;
		}
		if (item?.type === "mcp_tool_call") {
			const server = optionalString$1(item.server);
			const tool = optionalString$1(item.tool);
			if (id === void 0 || tool === void 0) continue;
			activities.push({
				id,
				kind: "tool",
				label: `${server === void 0 ? "" : `${server}/`}${tool}`.slice(0, MAX_ACTIVITY_LABEL_CHARS),
				status: optionalString$1(item.status) ?? "completed"
			});
		} else if (item?.type === "web_search") {
			const query = optionalString$1(item.query);
			if (id === void 0 || query === void 0) continue;
			if (query.length > MAX_ACTIVITY_LABEL_CHARS) truncated = true;
			activities.push({
				id,
				kind: "web-search",
				label: query.slice(0, MAX_ACTIVITY_LABEL_CHARS),
				status: "completed"
			});
		}
	}
	const isolation = optionalString$1(record(result?.isolation)?.effective);
	const modelRole = result === void 0 || result.model_role === null ? result?.model_role : optionalString$1(result.model_role);
	const provider = result === void 0 || result.provider === null ? result?.provider : optionalString$1(result.provider);
	const threadId = optionalString$1(result?.thread_id);
	const usage = usageOf(result);
	return {
		callId: call.callId,
		runner: events.text === void 0 ? "unknown" : "codex-exec",
		...threadId === void 0 ? {} : { threadId },
		model: optionalString$1(result?.model) ?? null,
		...modelRole === void 0 ? {} : { modelRole },
		...provider === void 0 ? {} : { provider },
		...isolation === void 0 ? {} : { isolation },
		messages,
		activities,
		...usage === void 0 ? {} : { usage },
		truncated
	};
}
//#endregion
//#region lib/types/fold.js
/**
* Pure fold of a KerSor `events.jsonl` stream into the viewer's run view
* model. One `KersorRunView` accumulates every event of a single run; phases
* are buckets in first-appearance order so loop re-visits (KSearch cycles
* Select/Generate/Evaluate) each get their own bucket.
* @module @deepseek-ai/dsh-kersor-viewer
*/
function errorMessage(error) {
	if (typeof error === "string") return error;
	if (error && typeof error === "object" && typeof error.message === "string") return error.message;
}
function totalTokens(usage) {
	return usage && typeof usage === "object" && typeof usage.total_tokens === "number" ? usage.total_tokens : void 0;
}
function ensurePhase(view, title) {
	const existing = view.phases.at(-1);
	if (existing && existing.title === title) return existing;
	const phase = {
		title,
		index: view.phases.length,
		status: "running",
		calls: []
	};
	view.phases.push(phase);
	return phase;
}
function workflowName(script) {
	const parts = script.replaceAll("\\", "/").split("/").filter(Boolean);
	return parts.length > 1 ? parts.at(-2) : parts.at(-1);
}
/**
* Copy one canonical result into the flat wire projection and its grouped view.
* @param view - Mutable folded run receiving the result.
* @param result - Bounded candidate and Host verification projection.
*/
function applyWorkflowResult(view, result) {
	view.result = result;
	if (result.stage === void 0) delete view.candidateStage;
	else view.candidateStage = result.stage;
	if (result.verification === void 0) delete view.verification;
	else view.verification = result.verification;
	if (result.failureKind === void 0) delete view.failureKind;
	else view.failureKind = result.failureKind;
	if (result.selectedCandidateId === void 0) delete view.selectedCandidateId;
	else view.selectedCandidateId = result.selectedCandidateId;
	if (result.expectedCycles === void 0) delete view.expectedCycles;
	else view.expectedCycles = result.expectedCycles;
	if (result.measuredBaselineCycles === void 0) delete view.measuredBaselineCycles;
	else view.measuredBaselineCycles = result.measuredBaselineCycles;
	if (result.measuredCycles === void 0) delete view.measuredCycles;
	else view.measuredCycles = result.measuredCycles;
	if (result.estimatedSpeedup === void 0) delete view.estimatedSpeedup;
	else view.estimatedSpeedup = result.estimatedSpeedup;
	if (result.measuredSpeedup === void 0) delete view.measuredSpeedup;
	else view.measuredSpeedup = result.measuredSpeedup;
	if (result.incumbentCycles === void 0) delete view.incumbentCycles;
	else view.incumbentCycles = result.incumbentCycles;
	if (result.incumbentSpeedup === void 0) delete view.incumbentSpeedup;
	else view.incumbentSpeedup = result.incumbentSpeedup;
	if (result.bestImproved === void 0) delete view.bestImproved;
	else view.bestImproved = result.bestImproved;
	view.candidates = result.candidates;
}
function foldWorkflowLog(view, message) {
	const candidate = /: candidate ([A-Za-z0-9._-]+) accepted, expected_cycles=([0-9]+)/.exec(message);
	if (candidate !== null) {
		const id = candidate[1];
		const expectedCycles = Number(candidate[2]);
		if (id === void 0 || !Number.isFinite(expectedCycles)) return;
		const current = view.result ?? { candidates: [] };
		const candidates = current.candidates.some((row) => row.id === id) ? current.candidates : [...current.candidates, {
			id,
			expectedCycles
		}];
		applyWorkflowResult(view, {
			...current,
			candidates
		});
		return;
	}
	const selected = /: selected ([A-Za-z0-9._-]+) \(/.exec(message);
	if (selected?.[1] !== void 0) {
		const current = view.result ?? { candidates: [] };
		const chosen = current.candidates.find((row) => row.id === selected[1]);
		applyWorkflowResult(view, {
			...current,
			selectedCandidateId: selected[1],
			...chosen?.expectedCycles === void 0 ? {} : { expectedCycles: chosen.expectedCycles }
		});
	}
}
function callBucket(view, event, kind) {
	const seq = typeof event.seq === "number" ? event.seq : -1;
	const callId = typeof event.call_id === "string" ? event.call_id : `${event.phase ?? ""}/${event.label ?? ""}/${seq}`;
	for (let i = view.phases.length - 1; i >= 0; i -= 1) {
		const bucket = view.phases[i];
		if (bucket === void 0 || bucket.title !== (event.phase ?? "")) continue;
		const row = bucket.calls.find((call) => call.callId === callId);
		if (row) return row;
	}
	const phase = ensurePhase(view, event.phase ?? "");
	const row = {
		seq,
		callId,
		kind,
		label: typeof event.label === "string" ? event.label : callId,
		status: "running"
	};
	phase.calls.push(row);
	view.totals.calls += 1;
	return row;
}
/**
* Fold one parsed event into the view, mutating the view in place.
* @param view - Mutable run projection receiving the event.
* @param event - Validated Workflow runtime event.
*/
function foldEvent(view, event) {
	switch (event.type) {
		case "workflow.started":
			view.status = "running";
			view.startedTs = event.ts;
			if (typeof event.script === "string") view.workflow = workflowName(event.script);
			if (typeof event.script_hash === "string") view.scriptHash = event.script_hash;
			return;
		case "phase.changed": {
			const title = typeof event.phase === "string" ? event.phase : "";
			const current = view.phases.at(-1);
			if (current && current.title !== title && current.status === "running") current.status = "completed";
			view.currentPhase = title;
			ensurePhase(view, title);
			return;
		}
		case "workflow.completed": {
			view.status = "completed";
			view.endedTs = event.ts;
			const tokens = totalTokens(event.usage);
			if (tokens !== void 0) view.totals.tokens = tokens;
			const lastPhase = view.phases.at(-1);
			if (lastPhase !== void 0) lastPhase.status = "completed";
			return;
		}
		case "workflow.failed": {
			view.status = "failed";
			view.endedTs = event.ts;
			view.error = errorMessage(event.error);
			const tokens = totalTokens(event.usage);
			if (tokens !== void 0) view.totals.tokens = tokens;
			const lastPhase = view.phases.at(-1);
			if (lastPhase !== void 0) lastPhase.status = "failed";
			return;
		}
		case "agent.queued":
		case "evaluation.queued": {
			const phase = ensurePhase(view, event.phase ?? "");
			const seq = typeof event.seq === "number" ? event.seq : -1;
			const callId = typeof event.call_id === "string" ? event.call_id : "";
			if (phase.calls.some((call) => call.callId === callId)) return;
			const row = {
				seq,
				callId,
				kind: event.type === "agent.queued" ? "agent" : "evaluation",
				label: typeof event.label === "string" ? event.label : callId,
				status: "queued"
			};
			phase.calls.push(row);
			view.totals.calls += 1;
			return;
		}
		case "agent.started":
		case "evaluation.started": {
			const row = callBucket(view, event, event.type === "agent.started" ? "agent" : "evaluation");
			if (!row) return;
			row.status = "running";
			row.startedTs = event.ts;
			return;
		}
		case "agent.completed":
		case "evaluation.completed": {
			const row = callBucket(view, event, event.type === "agent.completed" ? "agent" : "evaluation");
			if (!row) return;
			row.status = "completed";
			row.endedTs = event.ts;
			const tokens = totalTokens(event.usage);
			if (tokens !== void 0) {
				row.tokens = tokens;
				view.totals.tokens += tokens;
			}
			view.totals.completed += 1;
			return;
		}
		case "agent.failed":
		case "evaluation.failed": {
			const row = callBucket(view, event, event.type === "agent.failed" ? "agent" : "evaluation");
			if (!row) return;
			row.status = "failed";
			row.endedTs = event.ts;
			row.error = errorMessage(event.error);
			const tokens = totalTokens(event.usage);
			if (tokens !== void 0) {
				row.tokens = tokens;
				view.totals.tokens += tokens;
			}
			view.totals.failed += 1;
			return;
		}
		case "agent.transaction.rolled-back": {
			const row = callBucket(view, event, "agent");
			if (row) row.rolledBack = true;
			return;
		}
		case "workflow.log":
			if (typeof event.message === "string") foldWorkflowLog(view, event.message);
			return;
		default: return;
	}
}
/**
* Create an empty view for a discovered run directory.
* @param runId - Stable run identifier from discovery.
* @param runDir - Absolute discovered run directory.
* @param sessionDir - Absolute owning Session directory.
* @returns Empty projection ready for event folding.
*/
function createRunView(runId, runDir, sessionDir) {
	return {
		runId,
		runDir,
		sessionDir,
		status: "unknown",
		currentPhase: "",
		phases: [],
		totals: {
			calls: 0,
			completed: 0,
			failed: 0,
			tokens: 0
		}
	};
}
//#endregion
//#region lib/types/result.js
/** Bounded projection of a Workflow Host output for browser visualization. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_HOST_VERIFICATION_BYTES = 1024 * 1024;
const MAX_CANDIDATES = 20;
function optionalString(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
function optionalNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function failureKind(value) {
	const reason = typeof value === "string" ? value.toLowerCase() : "";
	if (reason.includes("correctness")) return "correctness";
	if (reason.includes("benchmark")) return "benchmark";
	return "infrastructure";
}
async function readObject(file, maxBytes) {
	try {
		const info = await stat(file);
		if (!info.isFile() || info.size > maxBytes) return void 0;
		const decoded = JSON.parse(await readFile(file, "utf8"));
		return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded) ? decoded : void 0;
	} catch {
		return;
	}
}
/**
* Read one canonical output without forwarding candidate source or arbitrary report text.
* @param runDir - Exact discovered run directory.
* @returns Bounded candidate-selection facts, or `undefined` when absent or invalid.
*/
async function readWorkflowResult(runDir) {
	const [value, host] = await Promise.all([readObject(path.join(runDir, "output.json"), MAX_OUTPUT_BYTES), readObject(path.join(runDir, "host-verification.json"), MAX_HOST_VERIFICATION_BYTES)]);
	try {
		if (value === void 0 && host === void 0) return void 0;
		const output = value ?? {};
		const candidates = (Array.isArray(output.candidate_log) ? output.candidate_log : []).slice(0, MAX_CANDIDATES).flatMap((candidate) => {
			if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return [];
			const row = candidate;
			const id = optionalString(row.candidate_id);
			if (id === void 0) return [];
			const expectedCycles = optionalNumber(row.expected_cycles);
			return [{
				id,
				...expectedCycles === void 0 ? {} : { expectedCycles }
			}];
		});
		const hostMetric = host?.verdict === "pass" && host.metric !== null && typeof host.metric === "object" && !Array.isArray(host.metric) ? host.metric : void 0;
		const verification = host?.verdict === "pass" ? "passed" : host?.verdict === "fail" ? "failed" : void 0;
		const rejectedKind = verification === "failed" ? failureKind(host?.reason) : void 0;
		const stage = verification === "passed" ? "host_verified" : verification === "failed" ? "host_rejected" : optionalString(output.arch_stage);
		const selectedCandidateId = optionalString(output.selected_candidate_id);
		const expectedCycles = optionalNumber(output.expected_cycles_estimate);
		const measuredBaselineCycles = optionalNumber(hostMetric?.baseline_cycles);
		const measuredCycles = optionalNumber(hostMetric?.candidate_cycles);
		const estimatedSpeedup = optionalNumber(output.estimated_speedup);
		const measured = hostMetric?.candidate_speedup ?? hostMetric?.speedup;
		const measuredSpeedup = measured === null ? null : optionalNumber(measured);
		const incumbentCycles = optionalNumber(hostMetric?.incumbent_cycles);
		const incumbentSpeedup = optionalNumber(hostMetric?.incumbent_speedup);
		const bestImproved = typeof hostMetric?.best_improved === "boolean" ? hostMetric.best_improved : void 0;
		if (stage === void 0 && verification === void 0 && selectedCandidateId === void 0 && expectedCycles === void 0 && measuredBaselineCycles === void 0 && measuredCycles === void 0 && estimatedSpeedup === void 0 && measuredSpeedup === void 0 && candidates.length === 0) return void 0;
		return {
			...stage === void 0 ? {} : { stage },
			...verification === void 0 ? {} : { verification },
			...rejectedKind === void 0 ? {} : { failureKind: rejectedKind },
			...selectedCandidateId === void 0 ? {} : { selectedCandidateId },
			...expectedCycles === void 0 ? {} : { expectedCycles },
			...measuredBaselineCycles === void 0 ? {} : { measuredBaselineCycles },
			...measuredCycles === void 0 ? {} : { measuredCycles },
			...estimatedSpeedup === void 0 ? {} : { estimatedSpeedup },
			...measuredSpeedup === void 0 ? {} : { measuredSpeedup },
			...incumbentCycles === void 0 ? {} : { incumbentCycles },
			...incumbentSpeedup === void 0 ? {} : { incumbentSpeedup },
			...bestImproved === void 0 ? {} : { bestImproved },
			candidates
		};
	} catch {
		return;
	}
}
//#endregion
//#region lib/types/scanner.js
/**
* Root-directory discovery of KerSor autonomous runs and bounded source observations.
* @module @deepseek-ai/dsh-kersor-viewer
*/
/** Default roots scanned in addition to configured ones. */
const DEFAULT_KERSOR_ROOTS = [path.join(homedir(), ".local", "share", "kersor"), path.join(homedir(), "Agent4Kernel", "KerSor", ".kersor")];
function expandHome(value) {
	if (value === "~") return homedir();
	return value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
}
async function configuredCheckout() {
	const fromEnvironment = process.env.KERSOR_ROOT?.trim();
	if (fromEnvironment) return { root: path.resolve(expandHome(fromEnvironment)) };
	const dshHome = process.env.DSH_HOME?.trim();
	const pointer = path.join(dshHome ? expandHome(dshHome) : path.join(homedir(), ".dsh"), ".agent-presets", "kersor", ".local", "kersor-root");
	try {
		const recorded = (await readFile(pointer, "utf8")).trim();
		return recorded ? { root: path.resolve(expandHome(recorded)) } : {};
	} catch (error) {
		if (errorCode(error) === "ENOENT") return {};
		return { issue: issueFromError("checkout_pointer", error, "warning") };
	}
}
function addCandidate(into, root, origin) {
	const expanded = path.resolve(expandHome(root));
	if (!into.has(expanded)) into.set(expanded, {
		root: expanded,
		origin
	});
}
function recordRootIssue(observation, issue) {
	observation.lastIssue = mergeIssue(observation.lastIssue, issue);
	observation.state = observation.state === "failed" ? "failed" : "degraded";
}
async function isSessionV2(dir) {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return { accepted: entries.some((entry) => entry.isFile() && entry.name === "session-config.json") && entries.some((entry) => entry.isFile() && entry.name === "state.json") };
	} catch (error) {
		const code = errorCode(error);
		if (code === "ENOENT" || code === "ENOTDIR") return { accepted: false };
		return {
			accepted: false,
			issue: issueFromError("session_inspect", error, "warning")
		};
	}
}
async function readSummary(file) {
	let text;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return {};
		return { issue: issueFromError("summary_read", error, "warning") };
	}
	let decoded;
	try {
		decoded = JSON.parse(text);
	} catch (error) {
		return { issue: issueFromError("summary_read", error, "warning") };
	}
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return { issue: createIssue("summary_read", "invalid_payload", "warning") };
	return { value: decoded };
}
async function scanSession(sessionDir, root) {
	const autonomousDir = path.join(sessionDir, "autonomous-runs");
	let autonomousChildren = [];
	try {
		autonomousChildren = await readdir(autonomousDir, { withFileTypes: true });
	} catch (error) {
		if (errorCode(error) !== "ENOENT") return {
			runs: [],
			issues: [],
			issue: issueFromError("runs_scan", error, "warning")
		};
	}
	const runs = [];
	const issues = [];
	const appendRun = async (runId, runDir, kind, round) => {
		if (kind === "classic-round") try {
			await access(path.join(runDir, ".runtime", "events.jsonl"));
		} catch (error) {
			if (errorCode(error) === "ENOENT") return;
			issues.push({
				runDir,
				issue: issueFromError("runs_scan", error, "warning")
			});
			return;
		}
		const summary = await readSummary(path.join(runDir, ".runtime", "summary.json"));
		let discovery = "active";
		if (summary.value !== void 0) {
			const status = summary.value.workflow_status ?? summary.value.status;
			if (status === "completed" || status === "waiting") discovery = "completed";
			else if (status === "error" || status === "failed") discovery = "failed";
			else if (status !== void 0) issues.push({
				runDir,
				issue: createIssue("summary_read", "invalid_payload", "warning")
			});
		}
		if (summary.issue !== void 0) issues.push({
			runDir,
			issue: summary.issue
		});
		const result = await readWorkflowResult(runDir);
		runs.push({
			runId,
			runDir,
			sessionDir,
			root,
			kind,
			...round === void 0 ? {} : { round },
			...result === void 0 ? {} : { result },
			discovery
		});
	};
	for (const child of autonomousChildren) {
		if (!child.isDirectory() && !child.isSymbolicLink()) continue;
		const runId = child.name;
		await appendRun(runId, path.join(autonomousDir, runId), "autonomous");
	}
	let sessionChildren;
	try {
		sessionChildren = await readdir(sessionDir, { withFileTypes: true });
	} catch (error) {
		return {
			runs,
			issues,
			issue: issueFromError("runs_scan", error, "warning")
		};
	}
	for (const child of sessionChildren) {
		if (!child.isDirectory() && !child.isSymbolicLink()) continue;
		const match = /^run-([1-9][0-9]*)$/.exec(child.name);
		if (match === null) continue;
		await appendRun(child.name, path.join(sessionDir, child.name), "classic-round", Number(match[1]));
	}
	return {
		runs,
		issues
	};
}
/**
* Scan all roots and return discovered runs plus bounded observations.
* @param roots - Explicit KerSor Session roots.
* @param includeDefaults - Whether built-in and installed-checkout roots participate.
* @param workspaceRoots - Registered and persisted DSH Workspace roots.
* @returns Complete committed inventory, run issues, and source observation.
*/
async function scanRoots(roots, includeDefaults, workspaceRoots = []) {
	const startedAt = (/* @__PURE__ */ new Date()).toISOString();
	const checkout = includeDefaults ? await configuredCheckout() : {};
	const candidates = /* @__PURE__ */ new Map();
	for (const root of roots) addCandidate(candidates, root, "configured");
	if (includeDefaults) {
		for (const root of DEFAULT_KERSOR_ROOTS) addCandidate(candidates, root, "default");
		if (checkout.root !== void 0) addCandidate(candidates, path.join(checkout.root, ".kersor"), "checkout");
	}
	for (const workspace of workspaceRoots) addCandidate(candidates, path.join(workspace, ".kersor"), "workspace");
	const runs = [];
	const runIssues = [];
	const observations = [];
	for (const candidate of candidates.values()) {
		const observation = {
			...candidate,
			state: "healthy",
			sessionsExamined: 0,
			sessionsAccepted: 0,
			runsFound: 0
		};
		let sessions;
		try {
			sessions = await readdir(candidate.root, { withFileTypes: true });
		} catch (error) {
			if (errorCode(error) === "ENOENT") {
				observation.state = "absent";
				if (candidate.origin === "configured") observation.lastIssue = issueFromError("root_scan", error, "warning");
			} else {
				observation.state = "failed";
				observation.lastIssue = issueFromError("root_scan", error);
			}
			observations.push(observation);
			continue;
		}
		for (const session of sessions) {
			if (!session.isDirectory() && !session.isSymbolicLink()) continue;
			observation.sessionsExamined += 1;
			const sessionDir = path.join(candidate.root, session.name);
			const inspected = await isSessionV2(sessionDir);
			if (inspected.issue !== void 0) recordRootIssue(observation, inspected.issue);
			if (!inspected.accepted) continue;
			observation.sessionsAccepted += 1;
			const scanned = await scanSession(sessionDir, candidate.root);
			if (scanned.issue !== void 0) recordRootIssue(observation, scanned.issue);
			runs.push(...scanned.runs);
			runIssues.push(...scanned.issues);
			observation.runsFound += scanned.runs.length;
			for (const scoped of scanned.issues) recordRootIssue(observation, scoped.issue);
		}
		observations.push(observation);
	}
	const hasReadable = observations.some((root) => root.state === "healthy" || root.state === "degraded");
	const state = checkout.issue !== void 0 || observations.some((root) => root.state === "failed" || root.state === "degraded" || root.state === "absent" && root.origin === "configured") ? hasReadable ? "degraded" : "failed" : "healthy";
	const completedAt = (/* @__PURE__ */ new Date()).toISOString();
	const lastIssue = checkout.issue ?? [...observations].reverse().find((root) => root.lastIssue !== void 0)?.lastIssue;
	return {
		runs,
		runIssues,
		observation: {
			state,
			startedAt,
			completedAt,
			...state === "failed" ? {} : { lastSuccessfulAt: completedAt },
			roots: observations,
			...lastIssue === void 0 ? {} : { lastIssue }
		}
	};
}
//#endregion
//#region lib/types/tailer.js
/**
* Position-tracking tail of one KerSor `events.jsonl`. The writer appends one
* JSON record per flushed line, so a byte-offset reader with truncation
* detection is a complete live stream; `fs.watch` wakes the reader and a slow
* poll backs it up on platforms where watch events lag (macOS FSEvents).
* @module @deepseek-ai/dsh-kersor-viewer
*/
/** Live reader over one events.jsonl file. */
var EventsTailer = class {
	file;
	pollMs;
	onLines;
	onEnd;
	onObservation;
	offset = 0;
	watcher;
	timer;
	reading = false;
	stopped = false;
	watchDegraded = false;
	observationState = {
		state: "waiting",
		byteOffset: 0,
		linesRead: 0
	};
	/**
	* @param file - absolute path to `events.jsonl`.
	* @param onLines - complete new lines (no trailing newline), in file order.
	* @param onEnd - optional callback when stop() completes.
	* @param options - polling interval and optional observation sink.
	*/
	constructor(file, onLines, onEnd, options = {}) {
		this.file = file;
		this.onLines = onLines;
		this.onEnd = onEnd;
		this.pollMs = options.pollMs ?? 300;
		this.onObservation = options.onObservation;
	}
	/** Begin watching; the first drain reads any lines already present. */
	start() {
		if (this.stopped) return;
		try {
			this.watcher = watch(path.dirname(this.file), { persistent: false }, (_event, filename) => {
				if (filename === null || filename === path.basename(this.file)) this.drain();
			});
			this.watcher.on("error", (error) => {
				this.recordWatchIssue(error);
			});
		} catch (error) {
			this.recordWatchIssue(error);
		}
		this.timer = setInterval(() => {
			this.drain();
		}, this.pollMs);
		this.timer.unref();
		this.drain();
	}
	/** Stop watching and invoke `onEnd`. Safe to call twice. */
	stop() {
		if (this.stopped) return;
		this.stopped = true;
		this.watcher?.close();
		if (this.timer !== void 0) clearInterval(this.timer);
		this.onEnd?.();
	}
	/** Current byte offset (diagnostics and tests). */
	get byteOffset() {
		return this.offset;
	}
	/** Complete current tail-source observation. */
	get observation() {
		return this.observationState;
	}
	/** Read newly appended complete lines; detect truncation and reset. */
	async drain() {
		if (this.reading || this.stopped) return;
		this.reading = true;
		try {
			let handle;
			try {
				handle = await open(this.file, "r");
			} catch (error) {
				if (errorCode(error) === "ENOENT") this.replaceObservation({ state: this.watchDegraded ? "degraded" : "waiting" });
				else this.recordReadIssue(error);
				return;
			}
			try {
				const { size } = await handle.stat();
				if (size < this.offset) this.offset = 0;
				if (size === this.offset) {
					this.recordReadSuccess(0);
					return;
				}
				const length = size - this.offset;
				const buffer = Buffer.alloc(length);
				const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
				const chunk = buffer.subarray(0, bytesRead).toString("utf8");
				const lastNewline = chunk.lastIndexOf("\n");
				if (lastNewline === -1) {
					this.recordReadSuccess(0);
					return;
				}
				const nextOffset = this.offset + lastNewline + 1;
				const lines = chunk.slice(0, lastNewline).split("\n").filter((line) => line.length > 0);
				if (lines.length > 0) this.onLines(lines);
				this.offset = nextOffset;
				this.recordReadSuccess(lines.length);
			} finally {
				await handle.close();
			}
		} catch (error) {
			this.recordReadIssue(error);
		} finally {
			this.reading = false;
		}
	}
	recordWatchIssue(error) {
		this.watchDegraded = true;
		const issue = issueFromError("tailer_watch", error, "warning");
		this.observationState = {
			...this.observationState,
			state: "degraded",
			lastIssue: mergeIssue(this.observationState.lastIssue, issue)
		};
		this.publishObservation();
	}
	recordReadIssue(error) {
		const issue = issueFromError("tailer_read", error);
		this.observationState = {
			...this.observationState,
			state: "failed",
			lastIssue: mergeIssue(this.observationState.lastIssue, issue)
		};
		this.publishObservation();
	}
	recordReadSuccess(lines) {
		this.observationState = {
			...this.observationState,
			state: this.watchDegraded ? "degraded" : "healthy",
			byteOffset: this.offset,
			linesRead: this.observationState.linesRead + lines,
			lastReadAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		this.publishObservation();
	}
	replaceObservation(replacement) {
		this.observationState = {
			...this.observationState,
			...replacement,
			byteOffset: this.offset
		};
		this.publishObservation();
	}
	publishObservation() {
		this.onObservation?.(this.observationState);
	}
};
//#endregion
//#region lib/types/service.js
/**
* KerSor viewer Host service: commits one inventory/diagnostics snapshot and
* folds each run's event stream for browser consumers.
* @module @deepseek-ai/dsh-kersor-viewer
*/
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/** Host service owning the viewer's single snapshot and folded run views. */
let KersorViewerService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _snapshot_decorators;
	let _runBacklog_decorators;
	let _runResult_decorators;
	let _runCallDetail_decorators;
	let _classicSessionDetail_decorators;
	return class KersorViewerService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_snapshot_decorators = [Remote("snapshot")];
			_runBacklog_decorators = [Remote("runBacklog")];
			_runResult_decorators = [Remote("runResult")];
			_runCallDetail_decorators = [Remote("runCallDetail")];
			_classicSessionDetail_decorators = [Remote("classicSessionDetail")];
			__esDecorate(this, null, _snapshot_decorators, {
				kind: "method",
				name: "snapshot",
				static: false,
				private: false,
				access: {
					has: (obj) => "snapshot" in obj,
					get: (obj) => obj.snapshot
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _runBacklog_decorators, {
				kind: "method",
				name: "runBacklog",
				static: false,
				private: false,
				access: {
					has: (obj) => "runBacklog" in obj,
					get: (obj) => obj.runBacklog
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _runResult_decorators, {
				kind: "method",
				name: "runResult",
				static: false,
				private: false,
				access: {
					has: (obj) => "runResult" in obj,
					get: (obj) => obj.runResult
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _runCallDetail_decorators, {
				kind: "method",
				name: "runCallDetail",
				static: false,
				private: false,
				access: {
					has: (obj) => "runCallDetail" in obj,
					get: (obj) => obj.runCallDetail
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _classicSessionDetail_decorators, {
				kind: "method",
				name: "classicSessionDetail",
				static: false,
				private: false,
				access: {
					has: (obj) => "classicSessionDetail" in obj,
					get: (obj) => obj.classicSessionDetail
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = ["workspaceRegistry", "sessionPersistence"];
		static Config = Schema.object({
			roots: Schema.array(Schema.string()).default([]),
			noDefaultRoots: Schema.boolean().default(false),
			scanIntervalMs: Schema.number().min(500).default(5e3),
			classicSessionLimit: Schema.number().step(1).min(0).max(100).default(20),
			classicStaleAfterSeconds: Schema.number().step(1).min(1).max(86400).default(1800)
		});
		rootCtx = __runInitializers(this, _instanceExtraInitializers);
		configuredRoots;
		includeDefaults;
		scanIntervalMs;
		classicSessionLimit;
		classicStaleAfterSeconds;
		tracked = /* @__PURE__ */ new Map();
		group;
		scanTimer;
		scanInFlight;
		persistedWorkspaceRoots = [];
		scanObservation = {
			state: "never",
			roots: []
		};
		classicSnapshot = {
			sessions: [],
			source: { state: "not_installed" }
		};
		lastPublishedSnapshotFingerprint;
		/** Create the service under the Host composition. */
		constructor(ctx, config) {
			super(ctx, "kersorViewer");
			this.rootCtx = ctx;
			this.configuredRoots = config.roots ?? [];
			this.includeDefaults = !(config.noDefaultRoots ?? false);
			this.scanIntervalMs = config.scanIntervalMs ?? 5e3;
			this.classicSessionLimit = config.classicSessionLimit ?? 20;
			this.classicStaleAfterSeconds = config.classicStaleAfterSeconds ?? 1800;
		}
		/** Start discovery and tailing under the plugin's fiber once ready. */
		*[Service.init]() {
			yield () => {
				for (const tracked of this.tracked.values()) tracked.tailer?.stop();
				this.tracked.clear();
				if (this.scanTimer !== void 0) clearInterval(this.scanTimer);
				this.scanTimer = void 0;
				this.group?.dispose();
				this.group = void 0;
			};
			this.requireGroup().effect(() => {
				this.rescan();
				this.scanTimer = setInterval(() => {
					this.rescan();
				}, this.scanIntervalMs);
				this.scanTimer.unref();
				return () => {
					if (this.scanTimer !== void 0) clearInterval(this.scanTimer);
					this.scanTimer = void 0;
				};
			});
		}
		requireGroup() {
			this.group ??= this.rootCtx.plugin({
				name: "kersor-viewer-group",
				apply: () => {}
			});
			return this.group;
		}
		/**
		* Read the complete inventory and source-health snapshot for refresh or reconnect.
		* @returns Current atomic Host projection with a fresh observation timestamp.
		*/
		snapshot() {
			return {
				asOf: (/* @__PURE__ */ new Date()).toISOString(),
				runs: [...this.tracked.values()].map((tracked) => tracked.ref).sort((left, right) => rank(right) - rank(left) || right.runId.localeCompare(left.runId)),
				classic: this.classicSnapshot,
				diagnostics: {
					scan: this.scanObservation,
					runs: [...this.tracked.values()].map((tracked) => tracked.observation).sort((left, right) => left.runDir.localeCompare(right.runDir))
				}
			};
		}
		/**
		* Read the full folded view of one discovered run.
		* @param runDir - Exact run directory from the current inventory.
		* @returns Folded backlog with bounded result, or `undefined` for an unknown run.
		*/
		async runBacklog(runDir) {
			const tracked = this.tracked.get(runDir);
			if (tracked === void 0) return void 0;
			const result = tracked.view.result ?? await readWorkflowResult(runDir);
			if (result !== void 0) applyWorkflowResult(tracked.view, result);
			return tracked.view;
		}
		/**
		* Read the bounded candidate-selection result for one discovered run.
		* @param runDir - Exact run directory from the current inventory.
		* @returns Candidate and Host verification projection, or `undefined` when absent.
		*/
		async runResult(runDir) {
			if (!this.tracked.has(runDir)) return void 0;
			return readWorkflowResult(runDir);
		}
		/**
		* Read bounded worker messages and activity names for one folded call.
		* @param runDir - Exact discovered run directory.
		* @param callId - Exact call identity present in that run's folded event stream.
		* @returns Bounded detail, or `undefined` when the run, call, or artifacts are absent.
		*/
		async runCallDetail(runDir, callId) {
			const tracked = this.tracked.get(runDir);
			if (tracked === void 0) return void 0;
			const call = tracked.view.phases.flatMap((phase) => phase.calls).find((candidate) => candidate.callId === callId);
			return call === void 0 ? void 0 : readCallDetail(runDir, call);
		}
		/**
		* Read sealed, bounded detail for one classic Session present in the snapshot.
		* @param sessionDir - Exact discovered Session directory.
		* @returns Inspector detail, or `undefined` for an unknown or unreadable Session.
		*/
		async classicSessionDetail(sessionDir) {
			if (!this.classicSnapshot.sessions.some((session) => session.session_dir === sessionDir)) return void 0;
			return readClassicSessionDetail(sessionDir);
		}
		/** Rescan roots once; concurrent callers share the in-flight scan. */
		async rescan() {
			if (this.scanInFlight !== void 0) return this.scanInFlight;
			this.scanObservation = {
				...this.scanObservation,
				state: "running",
				startedAt: (/* @__PURE__ */ new Date()).toISOString()
			};
			const current = this.performRescan().catch((error) => {
				const now = (/* @__PURE__ */ new Date()).toISOString();
				this.scanObservation = {
					...this.scanObservation,
					state: "failed",
					completedAt: now,
					lastIssue: issueFromError("root_scan", error)
				};
				this.publishSnapshot();
			});
			this.scanInFlight = current;
			try {
				await current;
			} finally {
				if (this.scanInFlight === current) this.scanInFlight = void 0;
			}
		}
		async performRescan() {
			const workspaceDiscovery = await this.discoverWorkspaceRoots();
			const workspaceRoots = workspaceDiscovery.roots;
			const [scanned, classic] = await Promise.all([scanRoots(this.configuredRoots, this.includeDefaults, workspaceRoots), this.classicSessionLimit === 0 ? Promise.resolve({
				sessions: [],
				source: { state: "disabled" }
			}) : readClassicSessions(this.classicSessionLimit, this.classicStaleAfterSeconds, {
				includeCheckoutRoot: this.includeDefaults,
				sessionRoots: this.configuredRoots,
				workspaceRoots
			})]);
			const previousSuccess = this.scanObservation.lastSuccessfulAt;
			const observation = workspaceDiscovery.issue === void 0 ? scanned.observation : {
				...scanned.observation,
				state: scanned.observation.state === "failed" ? "failed" : "degraded",
				lastIssue: mergeIssue(this.scanObservation.lastIssue, workspaceDiscovery.issue)
			};
			this.scanObservation = observation.state === "failed" && previousSuccess !== void 0 ? {
				...observation,
				lastSuccessfulAt: previousSuccess
			} : observation;
			this.classicSnapshot = classic;
			const byRunDir = new Map(scanned.runs.map((ref) => [ref.runDir, ref]));
			const scanIssues = new Map(scanned.runIssues.map((entry) => [entry.runDir, entry.issue]));
			for (const [runDir, tracked] of this.tracked) {
				if (byRunDir.has(runDir)) continue;
				tracked.tailer?.stop();
				this.tracked.delete(runDir);
			}
			for (const ref of scanned.runs) {
				const issue = scanIssues.get(ref.runDir);
				const existing = this.tracked.get(ref.runDir);
				if (existing !== void 0) {
					if (issue !== void 0) this.recordRunIssue(existing, issue);
					if (existing.ref.discovery !== ref.discovery) {
						if (existing.ref.discovery !== "active" && ref.discovery === "active") continue;
						existing.ref = ref;
						if (ref.discovery !== "active") {
							existing.tailer?.stop();
							existing.tailer = void 0;
							existing.view.status = terminalStatus(ref);
							existing.observation = {
								...existing.observation,
								state: existing.observation.lastIssue === void 0 ? "complete" : "degraded"
							};
							this.publishRun(existing.view);
							this.loadRunResult(existing);
						} else this.attachTailer(existing);
					}
					if (existing.view.result === void 0 && ref.discovery !== "active") this.loadRunResult(existing);
					continue;
				}
				const tracked = {
					ref,
					view: createRunView(ref.runId, ref.runDir, ref.sessionDir),
					tailer: void 0,
					observation: {
						runDir: ref.runDir,
						mode: ref.discovery === "active" ? "tail" : "backfill",
						state: issue === void 0 ? "waiting" : "degraded",
						byteOffset: 0,
						linesRead: 0,
						linesRejected: 0,
						...issue === void 0 ? {} : { lastIssue: issue }
					}
				};
				this.tracked.set(ref.runDir, tracked);
				if (ref.discovery === "active") this.attachTailer(tracked);
				else this.backfillTerminated(tracked);
			}
			this.publishSnapshot();
		}
		/** Merge managed Workspaces with durable Session cwd values, retaining the last good durable list on failure. */
		async discoverWorkspaceRoots() {
			const roots = /* @__PURE__ */ new Set();
			for (const workspace of this.rootCtx.workspaceRegistry.list()) {
				const normalized = normalizeAbsoluteCwd(workspace.path);
				if (normalized !== void 0) roots.add(normalized);
			}
			let issue;
			try {
				const persisted = /* @__PURE__ */ new Set();
				for (const header of await this.rootCtx.sessionPersistence.list()) {
					const normalized = normalizeAbsoluteCwd(header.cwd);
					if (normalized !== void 0) persisted.add(normalized);
				}
				this.persistedWorkspaceRoots = [...persisted].sort((left, right) => left.localeCompare(right));
			} catch (error) {
				issue = issueFromError("root_scan", error, "warning");
			}
			for (const persisted of this.persistedWorkspaceRoots) roots.add(persisted);
			return {
				roots: [...roots],
				...issue === void 0 ? {} : { issue }
			};
		}
		async backfillTerminated(tracked) {
			const { ref, view } = tracked;
			let text;
			try {
				text = await (await import("node:fs/promises")).readFile(`${ref.runDir}/.runtime/events.jsonl`, "utf8");
			} catch (error) {
				view.status = terminalStatus(ref);
				this.recordRunIssue(tracked, issueFromError("backfill_read", error));
				tracked.observation = {
					...tracked.observation,
					state: "failed"
				};
				if (this.tracked.get(ref.runDir) === tracked) {
					this.publishRun(view);
					this.publishSnapshot();
				}
				return;
			}
			for (const line of text.split("\n")) {
				if (line.length === 0) continue;
				tracked.observation = {
					...tracked.observation,
					linesRead: tracked.observation.linesRead + 1,
					lastReadAt: (/* @__PURE__ */ new Date()).toISOString()
				};
				this.foldLine(tracked, line);
			}
			if (view.status !== "completed" && view.status !== "failed") view.status = terminalStatus(ref);
			const result = await readWorkflowResult(ref.runDir);
			if (result !== void 0) applyWorkflowResult(view, result);
			tracked.observation = {
				...tracked.observation,
				state: tracked.observation.lastIssue === void 0 ? "complete" : "degraded",
				byteOffset: Buffer.byteLength(text)
			};
			if (this.tracked.get(ref.runDir) !== tracked) return;
			this.publishRun(view);
			this.publishSnapshot();
		}
		attachTailer(tracked) {
			if (tracked.tailer !== void 0) return;
			const { ref, view } = tracked;
			const tailer = new EventsTailer(`${ref.runDir}/.runtime/events.jsonl`, (lines) => {
				for (const line of lines) this.foldLine(tracked, line);
				tracked.observation = {
					...tracked.observation,
					state: tracked.observation.lastIssue === void 0 ? "healthy" : "degraded",
					byteOffset: tailer.byteOffset,
					linesRead: tracked.observation.linesRead + lines.length,
					lastReadAt: (/* @__PURE__ */ new Date()).toISOString()
				};
				this.publishRun(view);
				if (view.status === "completed" || view.status === "failed") {
					tracked.ref = {
						...tracked.ref,
						discovery: view.status
					};
					tracked.observation = {
						...tracked.observation,
						state: tracked.observation.lastIssue === void 0 ? "complete" : "degraded"
					};
					tailer.stop();
					this.loadRunResult(tracked);
				}
			}, () => {
				if (tracked.tailer === tailer) tracked.tailer = void 0;
			}, { onObservation: (observation) => {
				const previousFingerprint = observationFingerprint(tracked.observation);
				const currentIssue = tracked.observation.lastIssue;
				const tailerIssue = observation.lastIssue;
				const lastIssue = tailerIssue !== void 0 && (currentIssue === void 0 || tailerIssue.lastSeenAt >= currentIssue.lastSeenAt) ? tailerIssue : currentIssue;
				const terminal = tracked.view.status === "completed" || tracked.view.status === "failed";
				tracked.observation = {
					...tracked.observation,
					state: terminal ? lastIssue === void 0 ? "complete" : "degraded" : observation.state === "healthy" && lastIssue !== void 0 ? "degraded" : observation.state,
					byteOffset: observation.byteOffset,
					linesRead: observation.linesRead,
					...observation.lastReadAt === void 0 ? {} : { lastReadAt: observation.lastReadAt },
					...lastIssue === void 0 ? {} : { lastIssue }
				};
				if (observationFingerprint(tracked.observation) !== previousFingerprint) this.publishSnapshot();
			} });
			tracked.tailer = tailer;
			try {
				tailer.start();
			} catch (error) {
				tracked.tailer = void 0;
				this.recordRunIssue(tracked, issueFromError("tailer_watch", error));
				tracked.observation = {
					...tracked.observation,
					state: "failed"
				};
				this.publishSnapshot();
			}
		}
		async loadRunResult(tracked) {
			const result = await readWorkflowResult(tracked.ref.runDir);
			if (result === void 0 || this.tracked.get(tracked.ref.runDir) !== tracked) return;
			applyWorkflowResult(tracked.view, result);
			this.publishRun(tracked.view);
		}
		foldLine(tracked, line) {
			let decoded;
			try {
				decoded = JSON.parse(line);
			} catch (error) {
				this.rejectLine(tracked, issueFromError("event_parse", error, "warning"));
				return;
			}
			if (decoded === null || typeof decoded !== "object" || typeof decoded.type !== "string") {
				this.rejectLine(tracked, createIssue("event_parse", "invalid_payload", "warning"));
				return;
			}
			try {
				foldEvent(tracked.view, decoded);
			} catch (error) {
				this.rejectLine(tracked, issueFromError("event_fold", error, "warning"));
			}
		}
		rejectLine(tracked, issue) {
			this.recordRunIssue(tracked, issue);
			tracked.observation = {
				...tracked.observation,
				state: "degraded",
				linesRejected: tracked.observation.linesRejected + 1
			};
		}
		recordRunIssue(tracked, issue) {
			tracked.observation = {
				...tracked.observation,
				lastIssue: mergeIssue(tracked.observation.lastIssue, issue)
			};
		}
		publishSnapshot() {
			const snapshot = this.snapshot();
			const fingerprint = snapshotFingerprint(snapshot);
			if (fingerprint === this.lastPublishedSnapshotFingerprint) return;
			this.lastPublishedSnapshotFingerprint = fingerprint;
			this.rootCtx.emit("kersor/event", {
				kind: "snapshot",
				snapshot
			});
		}
		publishRun(run) {
			this.rootCtx.emit("kersor/event", {
				kind: "run",
				run
			});
		}
	};
})();
function normalizeAbsoluteCwd(value) {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !path.isAbsolute(value)) return;
	return path.normalize(value);
}
function rank(ref) {
	if (ref.discovery === "active") return 2;
	if (ref.discovery === "failed") return 1;
	return 0;
}
function terminalStatus(ref) {
	return ref.discovery === "failed" ? "failed" : "completed";
}
function observationFingerprint(observation) {
	const issue = observation.lastIssue;
	return `${observation.state}:${observation.byteOffset}:${observation.linesRead}:${issue?.stage ?? ""}:${issue?.code ?? ""}:${issue?.occurrences ?? 0}`;
}
function issueFingerprint(issue) {
	return issue === void 0 ? void 0 : [
		issue.stage,
		issue.code,
		issue.severity
	];
}
/** Ignore scan clocks and repeated identical diagnostics when deciding whether browser state changed. */
function snapshotFingerprint(snapshot) {
	return JSON.stringify({
		runs: snapshot.runs,
		classic: {
			sessions: snapshot.classic.sessions,
			source: {
				state: snapshot.classic.source.state,
				issue: issueFingerprint(snapshot.classic.source.lastIssue)
			}
		},
		scan: {
			state: snapshot.diagnostics.scan.state,
			roots: snapshot.diagnostics.scan.roots.map((root) => ({
				root: root.root,
				origin: root.origin,
				state: root.state,
				sessionsExamined: root.sessionsExamined,
				sessionsAccepted: root.sessionsAccepted,
				runsFound: root.runsFound,
				issue: issueFingerprint(root.lastIssue)
			})),
			issue: issueFingerprint(snapshot.diagnostics.scan.lastIssue)
		},
		readers: snapshot.diagnostics.runs.map((run) => ({
			runDir: run.runDir,
			mode: run.mode,
			state: run.state,
			byteOffset: run.byteOffset,
			linesRead: run.linesRead,
			linesRejected: run.linesRejected,
			issue: issueFingerprint(run.lastIssue)
		}))
	});
}
//#endregion
export { KersorViewerService, KersorViewerService as default };

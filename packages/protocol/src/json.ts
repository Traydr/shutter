/**
 * A decoded JSON document: what `JSON.parse` and `Response.json()` yield before
 * any wire parser has run. Wire parsers accept this type so the untyped value
 * never travels further than the boundary reader that produced it.
 */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { toJsonSchemaObject } from "@t3tools/provider-core/server/textGenerationUtils";
import { omitOptionalNulls, toStrictJsonSchema } from "./strictJsonSchema.ts";

it("requires optional properties as nullable and closes every nested object", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, aliases: { type: "array", items: { type: "string" } } },
    required: ["name"],
  };
  expect(toStrictJsonSchema(schema)).toEqual({
    ...schema,
    required: ["name", "aliases"],
    additionalProperties: false,
    properties: {
      name: { type: "string" },
      aliases: { anyOf: [schema.properties.aliases, { type: "null" }] },
    },
  });
  expect(schema.required).toEqual(["name"]);
  expect(omitOptionalNulls({ name: "mass", aliases: null }, schema)).toEqual({ name: "mass" });
});

it("round-trips nested optional keys and arrays through the original Effect decoder", () => {
  const child = Schema.Struct({
    count: Schema.NumberFromString,
    label: Schema.optionalKey(Schema.String),
    nullable: Schema.NullOr(Schema.String),
  });
  const effectSchema = Schema.Struct({
    nested: Schema.optionalKey(child),
    children: Schema.Array(child),
  });
  const original = toJsonSchemaObject(Schema.toEncoded(effectSchema));
  const strict = toStrictJsonSchema(original);
  expect(strict).toMatchObject({
    required: ["nested", "children"],
    additionalProperties: false,
    properties: {
      nested: {
        anyOf: [
          { required: ["count", "label", "nullable"], additionalProperties: false },
          { type: "null" },
        ],
      },
      children: {
        items: { required: ["count", "label", "nullable"], additionalProperties: false },
      },
    },
  });
  const decoded = Schema.decodeUnknownSync(effectSchema)(
    omitOptionalNulls(
      {
        nested: { count: "2", label: null, nullable: null },
        children: [{ count: "3", label: null, nullable: null }],
      },
      original,
    ),
  );
  expect(decoded).toEqual({
    nested: { count: 2, nullable: null },
    children: [{ count: 3, nullable: null }],
  });
  expect(omitOptionalNulls({ nested: null, children: [] }, original)).toEqual({ children: [] });
});

it("preserves refs and normalizes optional keys through recursive defs", () => {
  const schema = {
    $ref: "#/$defs/node",
    $defs: {
      node: {
        type: "object",
        properties: { name: { type: "string" }, next: { $ref: "#/$defs/node" } },
        required: ["name"],
      },
    },
  };
  expect(toStrictJsonSchema(schema)).toMatchObject({
    $ref: schema.$ref,
    $defs: {
      node: {
        required: ["name", "next"],
        additionalProperties: false,
        properties: { next: { anyOf: [{ $ref: schema.$ref }, { type: "null" }] } },
      },
    },
  });
  expect(omitOptionalNulls({ name: "a", next: { name: "b", next: null } }, schema)).toEqual({
    name: "a",
    next: { name: "b" },
  });
});

it.each(["anyOf", "oneOf"])(
  "normalizes the matching %s branch without dropping required nulls",
  (kind) => {
    const schema = {
      [kind]: [
        {
          type: "object",
          properties: { kind: { const: "a" }, value: { type: "string" } },
          required: ["kind"],
        },
        {
          type: "object",
          properties: { kind: { const: "b" }, value: { type: "null" } },
          required: ["kind", "value"],
        },
      ],
    };
    expect(toStrictJsonSchema(schema)).toMatchObject({
      [kind]: [
        { required: ["kind", "value"], additionalProperties: false },
        { required: ["kind", "value"], additionalProperties: false },
      ],
    });
    expect(omitOptionalNulls({ kind: "a", value: null }, schema)).toEqual({ kind: "a" });
    expect(omitOptionalNulls({ kind: "b", value: null }, schema)).toEqual({
      kind: "b",
      value: null,
    });
  },
);

import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256 } from "./hash.ts";

test("sha256 matches the published test vectors", () => {
  assert.equal(sha256(""), "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256("abc"), "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "sha256:248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
});

test("canonicalJson sorts keys at every depth", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
});

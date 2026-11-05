import test from "node:test";
import assert from "node:assert/strict";

import { ownerAdmission } from "../server/auth.mjs";

function connectionWith(admission) {
  return {
    admit() {
      if (admission instanceof Error) throw admission;
      return admission;
    },
  };
}

test("ownerAdmission admits the DSH owner principal", () => {
  const decision = ownerAdmission(connectionWith({ peer: { principal: { kind: "owner" } } }), {});
  assert.deepEqual(decision, { ok: true });
});

test("ownerAdmission rejects every non-owner principal", () => {
  const shapes = [
    { peer: { principal: { kind: "member" } } },
    { peer: { principal: { kind: "guest" } } },
    { peer: {} },
    { peer: null },
    {},
    null,
  ];
  for (const admission of shapes) {
    assert.deepEqual(ownerAdmission(connectionWith(admission), {}), { ok: false, status: 403 });
  }
});

test("ownerAdmission passes through DSH's rejection status", () => {
  assert.deepEqual(ownerAdmission(connectionWith({ rejection: 401 }), {}), { ok: false, status: 401 });
  assert.deepEqual(ownerAdmission(connectionWith({ rejection: 403 }), {}), { ok: false, status: 403 });
  // Malformed rejection codes fail closed to 403, never to an allow.
  assert.deepEqual(ownerAdmission(connectionWith({ rejection: "yes" }), {}), { ok: false, status: 403 });
  assert.deepEqual(ownerAdmission(connectionWith({ rejection: 200 }), {}), { ok: false, status: 403 });
  assert.deepEqual(ownerAdmission(connectionWith({ rejection: 999 }), {}), { ok: false, status: 403 });
});

test("ownerAdmission fails closed when the connection is broken", () => {
  assert.deepEqual(ownerAdmission(null, {}), { ok: false, status: 403 });
  assert.deepEqual(ownerAdmission({}, {}), { ok: false, status: 403 });
  const thrown = ownerAdmission(connectionWith(new Error("admission exploded")), {});
  assert.equal(thrown.ok, false);
  assert.equal(thrown.status, 403);
  assert.equal(thrown.error.message, "admission exploded");
});

test("ownerAdmission ignores a rejection property on a non-object admission", () => {
  assert.deepEqual(ownerAdmission(connectionWith("owner"), {}), { ok: false, status: 403 });
  assert.deepEqual(ownerAdmission(connectionWith(0), {}), { ok: false, status: 403 });
});

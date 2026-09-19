// An in-memory stand-in for the Supabase client, covering the query shapes
// the OAuth code uses: select/insert/update/delete with eq, is, gt, order,
// maybeSingle and single. Enough to run a whole sign-in against.
import { randomUUID } from "node:crypto";

export function makeDb() {
  const store = new Map();
  const table = (name) => store.get(name) ?? (store.set(name, []), store.get(name));
  class Query {
    constructor(name) { this.name = name; this.filters = []; this.op = "select"; this.mode = "many"; this.returning = false; }
    select() { if (this.op === "select") return this; this.returning = true; return this; }
    insert(row) { this.op = "insert"; this.row = row; return this; }
    update(patch) { this.op = "update"; this.patch = patch; return this; }
    delete() { this.op = "delete"; return this; }
    eq(k, v) { this.filters.push((r) => r[k] === v); return this; }
    is(k, v) { this.filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return this; }
    gt(k, v) { this.filters.push((r) => r[k] > v); return this; }
    order() { return this; }
    maybeSingle() { this.mode = "maybe"; return this; }
    single() { this.mode = "single"; return this; }
    run() {
      if (store.missing) return { data: null, error: { message: `relation "public.${this.name}" does not exist in the schema cache` } };
      const rows = table(this.name);
      const hit = rows.filter((r) => this.filters.every((f) => f(r)));
      let data;
      if (this.op === "insert") {
        const row = { id: randomUUID(), created_at: new Date().toISOString(), ...this.row };
        rows.push(row);
        data = this.returning ? [row] : null;
      } else if (this.op === "update") {
        for (const r of hit) Object.assign(r, this.patch);
        data = this.returning ? hit : null;
      } else if (this.op === "delete") {
        for (const r of hit) rows.splice(rows.indexOf(r), 1);
        data = null;
      } else data = hit;
      if (this.mode === "maybe") data = data?.length > 1 ? undefined : data?.[0] ?? null;
      if (this.mode === "single") data = data?.[0];
      if (data === undefined) return { data: null, error: { message: "expected one row" } };
      return { data, error: null };
    }
    then(resolve, reject) { return Promise.resolve().then(() => this.run()).then(resolve, reject); }
  }
  const db = { from: (name) => new Query(name) };
  return { db, store };
}

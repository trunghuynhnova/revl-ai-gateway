import { handle } from "./gateway.js";

/** @type {import("./gateway.js").Deps} */
const deps = {
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
  uuid: () => crypto.randomUUID(),
  log: (entry) => console.log(JSON.stringify(entry)),
};

export default {
  /**
   * @param {Request} request
   * @param {Record<string, any>} env
   * @param {{ waitUntil(promise: Promise<unknown>): void }} ctx
   */
  fetch(request, env, ctx) {
    return handle(request, env, ctx, deps);
  },
};

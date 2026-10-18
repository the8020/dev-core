import { assertEquals } from "@std/assert";
import { installContextProvider } from "/p/the8020/kernel/defaults/config/runtime/deno/context/runtime.ts";
import type { SchemaPlan } from "/p/the8020/db/mod.ts";
import { development } from "../../src/development.ts";
import program from "./program.ts";
import assets from "../../terminals/assets.json" with { type: "json" };

interface Browser {
  evaluate<T>(expression: string): Promise<T>;
}

export default function fixture() {
  const original = {
    list: development.sandbox.list,
    sandbox: development.sandbox.run,
    preview: development.activate.preview,
    run: development.activate.run,
  };
  let calls = 0, forceCalls = 0, repairs = 0;
  const plan = (): SchemaPlan => ({
    identity: forceCalls ? "updated-candidate" : "first-candidate",
    tables: [{
      table_id: "example__testing__orders",
      source_package: "example/testing",
      previous_hash: "old",
      target_hash: "new",
      route: "attempt",
      reasons: ["changing status"],
      affected_columns: [{ name: "status", repair: "default" }],
      retired_columns: ["legacy"],
      incoming_references: [],
    }],
  });
  return {
    async run() {
      const restore = installContextProvider(() => ({
        authenticated: true,
        type: "service",
        id: "the8020/uui/session",
        username: "robot",
        userId: "user:robot",
        nodeId: "nod-0123456789",
        sandboxId: "sbx-0123456789",
        workerId: "wrk-0123456789",
        contextId: "ctx-0123456789",
      }));
      development.sandbox.list = () =>
        Promise.resolve([{
          user_id: "robot",
          sandbox_id: "sbx-0123456789",
          state: "READY",
        }]);
      development.sandbox.run = () => Promise.resolve({ sandbox: {} });
      development.activate.preview = (input) =>
        Promise.resolve({
          packages: repairs ? [] : [{
            package_id: "example/testing",
            change: "modified",
            changed_files: 1,
            added_rows: 1,
            removed_rows: 1,
            activation_ready: true,
            files: [],
          }],
          ...(input.schema_preview ? { schema_plan: plan() } : {}),
        });
      development.activate.run = (input) => {
        calls++;
        assertEquals(input.message, "Keep this draft");
        assertEquals(input.packages, "example/testing");
        if (!input.force_columns) {
          return Promise.resolve({
            success: false,
            status: "failed",
            error: "Migration required",
          });
        }
        assertEquals(input.force_columns, "example__testing__orders.status");
        assertEquals(input.approved_plan, plan().identity);
        forceCalls++;
        if (forceCalls === 1) {
          return Promise.resolve({
            success: false,
            status: "failed",
            error:
              "schema candidate or permitted damage changed; preview and confirm again",
          });
        }
        repairs++;
        return Promise.resolve({
          success: true,
          status: "complete",
          resumed: true,
          schema_result: {
            example__testing__orders: { route: "repair", columns: ["status"] },
          },
        });
      };
      try {
        await program();
      } finally {
        development.sandbox.list = original.list;
        development.sandbox.run = original.sandbox;
        development.activate.preview = original.preview;
        development.activate.run = original.run;
        restore();
      }
    },
    async verify(page: Browser) {
      const wait = async (expression: string) => {
        const until = Date.now() + 8000;
        while (!await page.evaluate<boolean>(expression)) {
          if (Date.now() > until) throw new Error(`Timed out: ${expression}`);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      };
      const button = async (label: string) => {
        const selector =
          `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${
            JSON.stringify(label)
          } && !b.disabled && !b.closest('[inert],[hidden]') && b.getClientRects().length)`;
        await wait(`!!(${selector})`);
        await page.evaluate(`(${selector}).click()`);
      };
      const modal = () =>
        wait(
          `document.querySelector('[data-bind="confirmed"]')?.getClientRects().length > 0`,
        );
      await button("Review changes");
      await wait(`!!document.querySelector('[data-bind="message"]')`);
      await wait(`!document.querySelector('#screen-back')?.disabled`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await page.evaluate(
        `(() => {const e=document.querySelector('[data-bind="message"]'); e.value='Keep this draft'; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await wait(`!document.querySelector('.screen:not([hidden])')?.inert`);
      await button("Activate all changes");
      await button("Force activation…");
      await modal();
      assertEquals(
        await page.evaluate(
          `document.querySelector('[data-bind="confirmed"]').checked`,
        ),
        false,
      );
      await button("Force activation");
      await new Promise((resolve) => setTimeout(resolve, 100));
      assertEquals(calls, 1);
      await button("Cancel");
      await wait(
        `document.querySelector('[data-bind="message"]')?.getClientRects().length > 0`,
      );
      assertEquals(
        await page.evaluate(
          `document.querySelector('[data-bind="message"]').value`,
        ),
        "Keep this draft",
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        await button("Force activation…");
        await modal();
        assertEquals(
          await page.evaluate(
            `document.querySelector('[data-bind="confirmed"]').checked`,
          ),
          false,
        );
        await page.evaluate(
          `document.querySelector('[data-bind="confirmed"]').click()`,
        );
        await button("Force activation");
        await wait(
          `document.querySelector('[data-bind="message"]')?.getClientRects().length > 0`,
        );
      }
      assertEquals(forceCalls, 2);
      assertEquals(repairs, 1);
      await wait(
        `[...document.querySelectorAll('[data-bind="status"]')].some(e => !e.closest('[hidden]') && e.getClientRects().length && e.value?.includes('incompatible cells repaired'))`,
      );
      await wait(
        `[...document.querySelectorAll('[data-bind="status"]')].some(e => !e.closest('[hidden]') && e.getClientRects().length && e.value?.includes('review remaining workspace changes'))`,
      );
    },
    serve(request: Request) {
      const path = new URL(request.url).pathname;
      return Promise.resolve(
        path.endsWith(assets.module)
          ? new Response(
            "export default ({host}) => {host.textContent='Fixture terminal';return {}}",
            { headers: { "content-type": "text/javascript" } },
          )
          : assets.styles.some((name) => path.endsWith(name))
          ? new Response("")
          : undefined,
      );
    },
    close() {
      return Promise.resolve();
    },
  };
}

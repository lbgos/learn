import { expect, it } from "vite-plus/test";
import { buildSimDocument } from "../sim.ts";

it("keeps script-closing content inside the sim code string and bundles offline dependencies", () => {
  const html = buildSimDocument({
    code: 'export default defineSim({title:"</script><script>oops()",init:()=>({x:1}),step:s=>s})',
    mode: "headless",
  });
  expect(html).not.toContain("</script><script>oops()");
  expect(html).toContain("\\u003c/script>");
  expect(html).toContain("__physicsHeadless");
  expect(html).not.toMatch(/<script[^>]+src=/);
  expect(html).toContain("connect-src 'none'");
});

import { describe, expect, it } from "vitest";
import type { Activity } from "../../src/app/workbench/contracts.ts";
import { collectTools, duration } from "../../web/src/execution-view.ts";
const event = (id: number, data: Activity["data"], text = ""): Activity => ({
  id,
  runId: "run",
  kind: "tool",
  text,
  at: id * 1000,
  data,
});
describe("compact execution projection", () => {
  it("keeps first-call order and fields across interleaved status updates", () => {
    const events = [
      event(
        1,
        { toolCallId: "read", status: "in_progress", input: "README.md", truncated: true },
        "读取文件",
      ),
      event(2, { toolCallId: "test", status: "in_progress" }, "运行测试"),
      event(3, {
        toolCallId: "read",
        status: "completed",
        output: "done",
        input: undefined,
        truncated: false,
      }),
      event(4, { toolCallId: "test", status: "failed" }),
    ];
    const tools = collectTools(events);
    expect(tools.map((tool) => tool.id)).toEqual(["read", "test"]);
    expect(tools[0]).toMatchObject({
      title: "读取文件",
      start: 1000,
      end: 3000,
      data: { input: "README.md", output: "done", status: "completed", truncated: true },
    });
    expect(tools[1]?.data.status).toBe("failed");
    expect(events[0]?.data?.status).toBe("in_progress");
  });
  it("does not silently drop older tool events without call identifiers", () => {
    expect(
      collectTools([event(1, undefined, "legacy"), event(2, undefined, "legacy")]),
    ).toHaveLength(2);
    expect(collectTools([])).toEqual([]);
  });
  it("formats observed durations without manufacturing missing values", () => {
    expect(duration(undefined)).toBe("—");
    expect(duration(NaN)).toBe("—");
    expect(duration(-1)).toBe("—");
    expect(duration(0)).toBe("0ms");
    expect(duration(1500)).toBe("1.5s");
    expect(duration(61000)).toBe("1m 1s");
  });
});

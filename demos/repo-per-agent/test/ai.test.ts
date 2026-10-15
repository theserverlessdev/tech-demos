import { describe, expect, test } from "bun:test";
import { buildModelInput, MODEL_OPTIONS, modelExhausted, modelText, ModelEditError, proposeEdit } from "../src/worker/ai";
import type { DemoEnv } from "../src/worker/env";

describe("GLM-5.3-flash request", () => {
  test("uses reasoning_effort low, 4096 tokens, and json_schema", () => {
    const input = buildModelInput("add reverse", { "src/task.ts": "export {}\n" });
    expect(input.max_tokens).toBe(4096);
    expect(input.reasoning_effort).toBe("low");
    expect(input.response_format.type).toBe("json_schema");
    expect(input.response_format.json_schema.name).toBe("file_edit");
    expect(input.response_format.json_schema.schema.properties.path.enum).toContain("src/task.ts");
    expect(MODEL_OPTIONS.max_tokens).toBe(4096);
    expect("chat_template_kwargs" in input).toBe(false);
  });

  test("null content and finish_reason length are token exhaustion", () => {
    expect(modelExhausted({ choices: [{ finish_reason: "length", message: { content: "{" } }] })).toBe(true);
    expect(modelExhausted({ choices: [{ finish_reason: "stop", message: { content: null } }] })).toBe(true);
    expect(modelExhausted({ choices: [{ finish_reason: "stop", message: { content: '{"path":"README.md"}' } }] })).toBe(false);
    expect(() => modelText({ choices: [{ finish_reason: "length", message: { content: null } }] })).toThrow("ran out of tokens");
  });

  test("proposeEdit reports token exhaustion instead of missing JSON", async () => {
    const env = {
      AI_MODEL: "@cf/zai-org/glm-5.3-flash",
      AI: {
        run: async () => ({ choices: [{ finish_reason: "length", message: { content: null } }] }),
      },
    } as unknown as DemoEnv;
    try {
      await proposeEdit(env, "edit", { "README.md": "# hi\n" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelEditError);
      expect((err as Error).message).toContain("ran out of tokens");
      expect((err as Error).message).not.toContain("did not return JSON");
    }
  });

  test("proposeEdit accepts a scripted JSON body", async () => {
    const env = {
      AI_MODEL: "@cf/zai-org/glm-5.3-flash",
      AI: {
        run: async () => ({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify({ path: "NOTES.md", content: "# Notes\n\nDone.\n", message: "Fill notes" }) },
            },
          ],
        }),
      },
    } as unknown as DemoEnv;
    const edit = await proposeEdit(env, "fill notes", { "NOTES.md": "# Notes\n\nNothing here yet.\n" });
    expect(edit.path).toBe("NOTES.md");
    expect(edit.message).toBe("Fill notes");
    expect(edit.content).toContain("Done.");
  });
});

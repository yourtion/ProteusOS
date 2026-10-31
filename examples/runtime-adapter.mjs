/** Copy to ~/.proteus-local/runtime-adapter.mjs. No repository imports required. */
export default {
  version: "proteus-runtime-adapter-v1",
  id: "my-runtime@1",
  decisions: [
    {
      name: "custom-decision",
      remote: false,
      capabilities() {
        return { problems: ["choice"] };
      },
      async decide(request) {
        request.signal?.throwIfAborted();
        const provenance = { provider: this.name, policyVersion: request.policy.versionId };
        // The graph selects this provider; the immutable policy supplies its preferred option.
        const choice = request.policy.content?.preferredExecutor;
        if (typeof choice !== "string" || !request.options.includes(choice)) {
          return { kind: "abstain", reason: "策略未指定合法的执行选项", provenance };
        }
        return { kind: "value", value: choice, provenance };
      },
    },
  ],
};

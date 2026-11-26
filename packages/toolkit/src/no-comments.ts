type Comment = { type: string; range: [number, number] };
type Context = {
  sourceCode: { getAllComments(): Comment[] };
  report(descriptor: { message: string; loc?: unknown; node?: unknown }): void;
};
const rule = {
  create(context: Context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type === "Shebang" || comment.type === "Hashbang")
            continue;
          context.report({
            message: "Comments are not allowed.",
            node: comment,
          });
        }
      },
    };
  },
};
export default { meta: { name: "repo" }, rules: { "no-comments": rule } };

// Turns a roadmap task into a composer draft. Pure, so it's shared by the
// desktop and the phone and tested in Node.

// Only tasks that are about code get the button.
export function canAskAgent(task) {
  return Boolean(task) && !task.done && (task.repair || task.custom || task.category === "Build");
}

export function taskAgentDraft(task) {
  const items = task.auditItems || [];
  const lines = [`Roadmap task: ${task.title}`];
  if (task.detail) lines.push("", task.detail);
  if (task.doneWhen) lines.push("", `Done when: ${task.doneWhen}`);
  if (items.length) {
    lines.push("", "Audit items (historical findings: verify each against the current code first):");
    for (const item of items) lines.push(`- ${item.id}: ${item.title}`);
  }
  lines.push("", task.repair
    ? "Start by explaining what is wrong and how you would fix each item, so I can make the repair myself. Don't edit files unless I ask."
    : "Propose a short plan first: the files you'd change, the approach, and how you'd verify it.");
  // The audit names the repo for repair work; anything else uses the composer's default.
  const repo = items.find((item) => item.repo)?.repo || "";
  return {
    title: task.title.slice(0, 120),
    prompt: lines.join("\n"),
    mode: "plan",
    loop: false,
    taskId: task.id,
    taskTitle: task.title.slice(0, 200),
    ...(repo ? { projectId: repo } : {})
  };
}

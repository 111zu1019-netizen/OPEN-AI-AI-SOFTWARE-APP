function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

module.exports = {
  name: "mention-routing",
  description: "Routes a message to @named agents or broadcasts to everyone with @all.",
  beforeAgentSelection(payload, context) {
    const mentions = Array.from(payload.message.text.matchAll(/@([a-z0-9-_]+)/gi)).map((match) =>
      match[1].toLowerCase()
    );

    if (!mentions.length) {
      return payload;
    }

    if (mentions.includes("all")) {
      return {
        ...payload,
        candidateAgentIds: context.room.agents.filter((agent) => agent.active).map((agent) => agent.id)
      };
    }

    const targeted = context.room.agents.filter((agent) => {
      const name = slugify(agent.name);
      return mentions.includes(name) || mentions.includes(agent.id.toLowerCase());
    });

    if (!targeted.length) {
      return payload;
    }

    return {
      ...payload,
      candidateAgentIds: targeted.map((agent) => agent.id)
    };
  }
};

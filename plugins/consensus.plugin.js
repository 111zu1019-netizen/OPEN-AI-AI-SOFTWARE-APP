module.exports = {
  name: "consensus-tracker",
  description: "Publishes system notes when recent agent messages look aligned or deadlocked.",
  async afterBroadcast(message, context) {
    if (message.origin !== "agent") {
      return;
    }

    const recent = context.room.messages.filter((entry) => entry.origin === "agent").slice(-4);
    if (recent.length < 4) {
      return;
    }

    const joined = recent.map((entry) => entry.text.toLowerCase()).join(" ");
    const agreementSignals = (joined.match(/\b(agree|yes|align|same|ship)\b/g) || []).length;
    const disagreementSignals = (joined.match(/\b(disagree|risk|concern|no|but)\b/g) || []).length;

    const gap = context.room.messages.length - context.room.lastConsensusAt;
    if (gap < 6) {
      return;
    }

    if (agreementSignals >= 3) {
      context.room.lastConsensusAt = context.room.messages.length;
      await context.helpers.emitSystem("Consensus is forming. This might be a good moment to turn the thread into an action item.");
      return;
    }

    if (disagreementSignals >= 3) {
      context.room.lastConsensusAt = context.room.messages.length;
      await context.helpers.emitSystem("The room is diverging. Try narrowing the question or mentioning a specific agent for a focused reply.");
    }
  }
};

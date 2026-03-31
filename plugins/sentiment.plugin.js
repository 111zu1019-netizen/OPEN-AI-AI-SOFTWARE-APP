module.exports = {
  name: "sentiment-badges",
  description: "Adds lightweight sentiment and urgency badges to each message.",
  beforeBroadcast(message) {
    const text = message.text.toLowerCase();
    const badges = new Set(message.badges || []);

    if (/\b(ship|great|love|strong|clear|yes)\b/.test(text)) {
      badges.add("positive");
    }

    if (/\b(risk|bug|blocker|no|fail|concern)\b/.test(text)) {
      badges.add("risk");
    }

    if (/\b(now|urgent|asap|today|immediately)\b/.test(text)) {
      badges.add("urgent");
    }

    return {
      ...message,
      badges: Array.from(badges)
    };
  }
};

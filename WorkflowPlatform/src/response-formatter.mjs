const labels = {
  prototype: "быстрый прототип",
  mvp: "рабочий первый вариант",
  production: "готовый надёжный результат",
  security: "проверка безопасности"
};

export function formatQuestions({ summary, questions = [], nextStep = "продолжить работу" }) {
  const lines = questions.map((question, index) => `${index + 1}. ${question}`).join("\n");
  return `Понял задачу: ${summary}\n\nЧтобы ${nextStep}, мне нужно уточнить:\n${lines}\n\nОтветь, пожалуйста, обычными словами. После этого я продолжу.`;
}

export function formatClassification({ summary, quality, nextStep, questions = [] }) {
  if (questions.length) return formatQuestions({ summary, questions, nextStep });
  if (!quality) return `${summary}\n\nСледующий шаг: ${nextStep}.`;
  const mode = labels[quality] ?? "подходящий режим качества";
  return `${summary}\n\nДальше я подготовлю ${mode} и проверю результат. Следующий шаг: ${nextStep}.`;
}

export function formatCompletion({ summary, completed = [], nextStep, needsDecision = false }) {
  const done = completed.length ? `\n\nГотово:\n${completed.map(item => `- ${item}`).join("\n")}` : "";
  const decision = needsDecision ? "\n\nНужно ваше решение, прежде чем продолжать." : "";
  return `${summary}${done}${decision}${nextStep ? `\n\nДальше: ${nextStep}.` : ""}`;
}

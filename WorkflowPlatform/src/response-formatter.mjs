import { normalizeLanguage } from "./language.mjs";

const copy = {
  en: {
    quality: { prototype: "a quick prototype", mvp: "a working first version", production: "a reliable production result", security: "a security review" },
    understood: summary => `I understand the task: ${summary}`,
    clarification: nextStep => `To ${nextStep}, I need to clarify:`,
    answerNaturally: "Please answer in your own words. I will continue after that.",
    next: nextStep => `Next: ${nextStep}.`,
    prepare: mode => `I will now prepare ${mode} and verify the result.`,
    done: "Completed:",
    decision: "I need your decision before continuing."
  },
  ru: {
    quality: { prototype: "быстрый прототип", mvp: "рабочий первый вариант", production: "готовый надёжный результат", security: "проверку безопасности" },
    understood: summary => `Понял задачу: ${summary}`,
    clarification: nextStep => `Чтобы ${nextStep}, мне нужно уточнить:`,
    answerNaturally: "Ответь, пожалуйста, обычными словами. После этого я продолжу.",
    next: nextStep => `Дальше: ${nextStep}.`,
    prepare: mode => `Дальше я подготовлю ${mode} и проверю результат.`,
    done: "Готово:",
    decision: "Нужно ваше решение, прежде чем продолжать."
  }
};

function selected(language) { return copy[normalizeLanguage(language) ?? "en"]; }

export function formatQuestions({ summary, questions = [], nextStep, language = "en" }) {
  const text = selected(language);
  const target = nextStep || (normalizeLanguage(language) === "ru" ? "продолжить работу" : "continue the work");
  const lines = questions.map((question, index) => `${index + 1}. ${question}`).join("\n");
  return `${text.understood(summary)}\n\n${text.clarification(target)}\n${lines}\n\n${text.answerNaturally}`;
}

export function formatClassification({ summary, quality, nextStep, questions = [], language = "en" }) {
  if (questions.length) return formatQuestions({ summary, questions, nextStep, language });
  const text = selected(language);
  if (!quality) return `${summary}\n\n${text.next(nextStep)}`;
  const mode = text.quality[quality] ?? (normalizeLanguage(language) === "ru" ? "подходящий режим качества" : "the appropriate quality level");
  return `${summary}\n\n${text.prepare(mode)} ${text.next(nextStep)}`;
}

export function formatCompletion({ summary, completed = [], nextStep, needsDecision = false, language = "en" }) {
  const text = selected(language);
  const done = completed.length ? `\n\n${text.done}\n${completed.map(item => `- ${item}`).join("\n")}` : "";
  const decision = needsDecision ? `\n\n${text.decision}` : "";
  return `${summary}${done}${decision}${nextStep ? `\n\n${text.next(nextStep)}` : ""}`;
}

export function workflowMessage(key, language = "en") {
  const ru = normalizeLanguage(language) === "ru";
  const values = {
    classificationFailed: ru ? "Не удалось надёжно определить маршрут задачи. Рабочие роли не запускались; нужно уточнить запрос или настройки проекта." : "I could not determine a reliable route for this task. No work roles were started; the request or project settings need clarification.",
    executionFailed: ru ? "Исполнительный этап не завершился. Повтор или эскалация будут выполнены только по правилам маршрута." : "The execution stage did not finish. A retry or escalation will happen only when the workflow rules allow it.",
    duplicate: ru ? "Это сообщение уже принято и не будет запущено повторно." : "This message has already been accepted and will not be run again.",
    completedReviewed: ru ? "Работа выполнена: программные проверки прошли, независимая проверка подтвердила результат, обязательная документация обновлена." : "The work is complete: programmatic checks passed, an independent review confirmed the result, and required documentation was updated.",
    completed: ru ? "Работа выполнена: программные проверки прошли, обязательная документация обновлена. Отдельная независимая проверка для этого уровня и риска не требовалась." : "The work is complete: programmatic checks passed and required documentation was updated. This quality level and risk did not require a separate independent review.",
    rejected: ru ? "Независимая проверка отклонила результат. Задача не завершена и не будет продолжена без нового решения." : "The independent review rejected the result. The task is not complete and will not continue without a new decision.",
    changesRequested: ru ? "Результат требует исправлений. Задача не завершена; повтор будет ограничен правилами маршрута." : "The result needs corrections. The task is not complete; any retry is limited by the workflow rules.",
    approvalDeclined: ru ? "Решение записано: действие отклонено, ожидавший его прогон закрыт." : "The decision is recorded: the action was declined and the run waiting for it is closed.",
    // A request for external evidence is not closed by a message saying the fact is true. Saying so
    // plainly is the point: otherwise the person believes the run is moving again while it is not.
    externalEvidencePending: ru ? "Запрос внешнего свидетельства остаётся открытым: его закрывает только доставленный пакет свидетельства, который проходит объявленный контракт. Прогон ждёт." : "The external evidence request stays open: only a delivered evidence packet that satisfies the declared contract closes it. The run is still waiting.",
    externalEvidenceCancelled: ru ? "Запрос внешнего свидетельства отменён по вашему решению; ожидавший его прогон закрыт." : "The external evidence request was cancelled at your decision, and the run waiting for it is closed.",
    controlledStop: ru ? "Исполнение остановлено в контролируемом состоянии; автоматическое завершение не выполнено." : "Execution stopped in a controlled state; the task was not marked complete automatically.",
    contractRejected: ru ? "Структурированный исполнительный контракт не прошёл проверку. Задача не завершена; повтор или эскалация возможны только по правилам маршрута." : "The structured execution contract failed validation. The task is not complete; retry or escalation is possible only under the workflow rules."
  };
  return values[key];
}

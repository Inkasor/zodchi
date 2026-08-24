import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLanguage, resolveResponseLanguage } from "../src/language.mjs";
import { formatQuestions, workflowMessage } from "../src/response-formatter.mjs";

test("language normalization accepts supported locale forms", () => {
  assert.equal(normalizeLanguage("ru-RU"), "ru");
  assert.equal(normalizeLanguage("en_US"), "en");
  assert.equal(normalizeLanguage("de-DE"), null);
});

test("current conversation language overrides the configured fallback", () => {
  assert.equal(resolveResponseLanguage({ message: "Привет", preferredLanguage: "en" }), "ru");
  assert.equal(resolveResponseLanguage({ message: "Please continue", preferredLanguage: "ru" }), "en");
});

test("short ambiguous replies preserve the preceding conversation language", () => {
  const history = [{ role: "assistant", content: "Продолжить работу?" }];
  assert.equal(resolveResponseLanguage({ message: "ok", preferredLanguage: "en", history }), "ru");
  assert.equal(resolveResponseLanguage({ message: "да", preferredLanguage: "en", history: [] }), "ru");
  assert.equal(resolveResponseLanguage({ message: "ok", preferredLanguage: "ru", history: [] }), "ru");
});

test("response formatter renders both public languages", () => {
  assert.match(formatQuestions({ summary: "Need a target.", questions: ["Which file?"], nextStep: "continue", language: "en" }), /Please answer in your own words/);
  assert.match(formatQuestions({ summary: "Нужна цель.", questions: ["Какой файл?"], nextStep: "продолжить", language: "ru" }), /Ответь, пожалуйста/);
  assert.match(workflowMessage("classificationFailed", "en"), /No work roles were started/);
  assert.match(workflowMessage("classificationFailed", "ru"), /Рабочие роли не запускались/);
});

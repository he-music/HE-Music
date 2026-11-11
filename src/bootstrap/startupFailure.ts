import zh from "@/i18n/locales/startup.zh-CN.json";
import en from "@/i18n/locales/startup.en.json";
import "./startupFailure.css";

interface StartupFailureOptions {
  message?: string;
  detail?: string;
}

/** 启动恢复完成前不能加载应用、状态管理或依赖设置的国际化实例。 */
export function showStartupFailure(options: StartupFailureOptions = {}): void {
  const target = document.getElementById("app");
  if (!target) return;
  const text = navigator.language.startsWith("zh") ? zh : en;
  const section = document.createElement("section");
  section.className = "startup-failure";
  section.setAttribute("aria-labelledby", "startup-failure-title");
  const panel = document.createElement("div");
  panel.className = "startup-failure-panel";
  const title = document.createElement("h1");
  title.id = "startup-failure-title";
  title.textContent = text.title;
  const message = document.createElement("p");
  message.setAttribute("role", "alert");
  message.textContent = options.message ?? text.message;
  panel.append(title, message);
  if (options.detail) {
    const detail = document.createElement("p");
    detail.textContent = options.detail;
    panel.append(detail);
  }
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = text.retry;
  retry.onclick = () => window.location.reload();
  panel.append(retry);
  section.append(panel);
  target.replaceChildren(section);
}

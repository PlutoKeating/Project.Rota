import { createWorker, OEM, PSM, type Worker } from "tesseract.js";

type Language = "chi_sim" | "eng" | "chi_sim+eng";
let shared: Promise<Worker> | undefined;
let ready = false;
let loadedLanguage: string | undefined;
let queue: Promise<unknown> = Promise.resolve();
let idle: ReturnType<typeof setTimeout> | undefined;

// Engine + language data are ~10 MB. Their download is never cut short by a
// recognition timeout (that used to restart the download forever on slow
// links); callers that cannot wait get a quick, retryable answer instead.
const WAIT_FOR_ENGINE_MS = 20000;
const RECOGNIZE_MS = 90000;

function engine(language: Language) {
  if (!shared) {
    ready = false;
    shared = createWorker(language, OEM.LSTM_ONLY, {
      workerPath: new URL("/vendor/ocr/worker.min.js", location.origin).href,
      corePath: new URL("/vendor/ocr", location.origin).href,
      langPath: new URL("/vendor/ocr", location.origin).href,
      workerBlobURL: false,
    });
    loadedLanguage = language;
    shared.then(
      () => (ready = true),
      () => {
        shared = undefined;
        loadedLanguage = undefined;
      },
    );
  }
  return shared;
}

/** Start the one-time engine download early so the first OCR call finds it ready. */
export function warmOcr() {
  void engine("chi_sim").catch(() => {});
}

function reset() {
  const old = shared;
  shared = undefined;
  ready = false;
  loadedLanguage = undefined;
  void old?.then((w) => w.terminate()).catch(() => {});
}

function within<T>(work: Promise<T>, ms: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function recognizeImage(
  image: string,
  language: Language = "chi_sim",
  layout: "auto" | "sparse" | "block" = "auto",
) {
  const loading = engine(language);
  // Queue time and engine download do not count against recognition.
  const task = queue
    .catch(() => {})
    .then(async () => {
      clearTimeout(idle);
      if (!ready)
        await within(
          loading,
          WAIT_FOR_ENGINE_MS,
          "本地 OCR 组件仍在下载（首次约 10 MB），暂不可用；请直接查看图片或裁剪放大，不要重复调用 OCR",
        );
      const worker = await loading;
      try {
        if (loadedLanguage !== language) {
          await worker.reinitialize(language);
          loadedLanguage = language;
        }
        return await within(
          (async () => {
            await worker.setParameters({
              tessedit_pageseg_mode:
                layout === "sparse"
                  ? PSM.SPARSE_TEXT
                  : layout === "block"
                    ? PSM.SINGLE_BLOCK
                    : PSM.AUTO,
              preserve_interword_spaces: "1",
            });
            const { data } = await worker.recognize(
              image,
              {},
              { text: true, blocks: true },
            );
            return {
              text: data.text,
              confidence: data.confidence,
              lines: (data.blocks ?? []).flatMap((b) =>
                b.paragraphs.flatMap((p) =>
                  p.lines.map((l) => ({
                    text: l.text,
                    bbox: l.bbox,
                    confidence: l.confidence,
                  })),
                ),
              ),
            };
          })(),
          RECOGNIZE_MS,
          "本地 OCR 超时，请缩小读取区域重试",
        );
      } catch (e) {
        // A stuck recognition (not a slow download) poisons the worker.
        if (ready) reset();
        throw e;
      }
    })
    .finally(() => {
      clearTimeout(idle);
      // Release memory when unused, but never abort an in-progress download.
      idle = setTimeout(() => ready && reset(), 300000);
    });
  queue = task;
  return task;
}

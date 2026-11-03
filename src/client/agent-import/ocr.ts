import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
let shared: Promise<Worker> | undefined;
let loadedLanguage: string | undefined;
let queue: Promise<unknown> = Promise.resolve();
let idle: ReturnType<typeof setTimeout> | undefined;
export function recognizeImage(
  image: string,
  language: "chi_sim" | "eng" | "chi_sim+eng" = "chi_sim",
  layout: "auto" | "sparse" | "block" = "auto",
) {
  const task = queue
    .catch(() => {})
    .then(async () => {
      clearTimeout(idle);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const work = async () => {
        const worker = await (shared ??= createWorker(language, OEM.LSTM_ONLY, {
          workerPath: new URL("/vendor/ocr/worker.min.js", location.origin)
            .href,
          corePath: new URL("/vendor/ocr", location.origin).href,
          langPath: new URL("/vendor/ocr", location.origin).href,
          workerBlobURL: false,
        }));
        if (loadedLanguage && loadedLanguage !== language)
          await worker.reinitialize(language);
        loadedLanguage = language;
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
      };
      try {
        return await Promise.race([
          work(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Error("本地 OCR 超时，请缩小读取区域重试")),
              90000,
            );
          }),
        ]);
      } catch (e) {
        const old = shared;
        shared = undefined;
        loadedLanguage = undefined;
        void old?.then((w) => w.terminate()).catch(() => {});
        throw e;
      } finally {
        clearTimeout(timer);
        idle = setTimeout(() => {
          queue = Promise.resolve();
          const old = shared;
          shared = undefined;
          loadedLanguage = undefined;
          void old?.then((w) => w.terminate()).catch(() => {});
        }, 300000);
      }
    });
  queue = task;
  return task;
}

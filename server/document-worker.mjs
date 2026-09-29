// Parsing runs outside the HTTP event loop, with a parent-enforced deadline and
// memory limit. No document-provided URL or external file is ever opened.
process.once('message', async workerData => {
try {
  const buffer = Buffer.from(workerData.base64, 'base64');
  let text = '';
  if (workerData.kind === 'pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buffer), isEvalSupported: false });
    try {
      const info = await parser.getInfo();
      if (info.total > 200) throw new Error('PDF 最多支持 200 页，请拆分后上传。');
      text = (await parser.getText()).text;
    } finally { await parser.destroy(); }
  } else {
    const { default: mammoth } = await import('mammoth');
    text = (await mammoth.extractRawText({ buffer }, { externalFileAccess: false })).value;
  }
  text = text.replace(/\u0000/g, '').trim();
  process.send({ text: text.slice(0, workerData.maxCharacters), extractedCharacters: text.length, truncated: text.length > workerData.maxCharacters });
} catch (error) {
  process.send({ error: error instanceof Error && error.message.startsWith('PDF 最多') ? error.message : '文档无法解析，可能已损坏、加密或格式不受支持。' });
}
});

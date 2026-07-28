// pdf.js — wrap JPEG renders into a PDF (US Letter, 612×792pt pages).
// Hand-built PDF 1.4 with one DCTDecode image XObject per page — no
// dependencies. JPEG is used (not PNG) because PDF embeds JPEG streams
// natively.

const PAGE_W = 612;
const PAGE_H = 792;

// pages: [{ jpeg: Buffer, width, height }, ...] — one full-bleed image per page.
export function jpegsToPdf(pages) {
  if (!Array.isArray(pages) || !pages.length) throw new Error("jpegsToPdf expects at least one page");
  for (const p of pages) {
    if (!Buffer.isBuffer(p.jpeg) || p.jpeg.length < 4 || p.jpeg[0] !== 0xff || p.jpeg[1] !== 0xd8) {
      throw new Error("jpegsToPdf expects JPEG bytes");
    }
  }

  // Object numbering: 1 = catalog, 2 = pages tree, then per page i (0-based):
  // page = 3 + i*3, image = 4 + i*3, content = 5 + i*3.
  const pageObj = (i) => 3 + i * 3;
  const imageObj = (i) => 4 + i * 3;
  const contentObj = (i) => 5 + i * 3;
  const totalObjs = 2 + pages.length * 3;

  const chunks = [];
  const offsets = [];
  let pos = 0;
  const push = (buf) => {
    chunks.push(buf);
    pos += buf.length;
  };

  push(Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1"));

  const pushObj = (num, header, stream) => {
    offsets[num] = pos;
    push(Buffer.from(`${num} 0 obj\n${header}\n`, "latin1"));
    if (stream) {
      push(Buffer.from("stream\n", "latin1"));
      push(stream);
      push(Buffer.from("\nendstream\n", "latin1"));
    }
    push(Buffer.from("endobj\n", "latin1"));
  };

  pushObj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  pushObj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${pages.length} >>`);

  pages.forEach((p, i) => {
    const content = Buffer.from(`q ${PAGE_W} 0 0 ${PAGE_H} 0 0 cm /Im${i} Do Q\n`, "latin1");
    pushObj(
      pageObj(i),
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /XObject << /Im${i} ${imageObj(i)} 0 R >> >> /Contents ${contentObj(i)} 0 R >>`
    );
    pushObj(
      imageObj(i),
      `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>`,
      p.jpeg
    );
    pushObj(contentObj(i), `<< /Length ${content.length} >>`, content);
  });

  const xrefPos = pos;
  let xref = `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= totalObjs; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  push(Buffer.from(xref, "latin1"));
  push(
    Buffer.from(
      `trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`,
      "latin1"
    )
  );

  return Buffer.concat(chunks);
}

export function jpegToPdf(jpeg, imgWidth, imgHeight) {
  return jpegsToPdf([{ jpeg, width: imgWidth, height: imgHeight }]);
}

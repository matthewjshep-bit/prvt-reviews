// pdf.js — wrap a JPEG render into a single-page PDF (US Letter, 612×792pt).
// Hand-built PDF 1.4 with one DCTDecode image XObject — no dependencies. JPEG
// is used (not PNG) because PDF embeds JPEG streams natively.

const PAGE_W = 612;
const PAGE_H = 792;

export function jpegToPdf(jpeg, imgWidth, imgHeight) {
  if (!Buffer.isBuffer(jpeg) || jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error("jpegToPdf expects JPEG bytes");
  }

  const content = Buffer.from(
    `q ${PAGE_W} 0 0 ${PAGE_H} 0 0 cm /Im0 Do Q\n`,
    "latin1"
  );

  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
    null, // image (binary, handled below)
    null, // content stream (handled below)
  ];

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

  pushObj(1, objects[0]);
  pushObj(2, objects[1]);
  pushObj(3, objects[2]);
  pushObj(
    4,
    `<< /Type /XObject /Subtype /Image /Width ${imgWidth} /Height ${imgHeight} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
    jpeg
  );
  pushObj(5, `<< /Length ${content.length} >>`, content);

  const xrefPos = pos;
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  push(Buffer.from(xref, "latin1"));
  push(
    Buffer.from(
      `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`,
      "latin1"
    )
  );

  return Buffer.concat(chunks);
}

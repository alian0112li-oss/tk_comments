// xlsx.js —— 零依赖的极简 XLSX 生成器（STORE 方式打包的 ZIP + Open XML）。
// 生成标准 .xlsx，Excel/WPS/Numbers 均可直接打开。
// 暴露： window.TKXlsx.build(sheets) -> Uint8Array
//   sheets = [{ name: "表名", rows: [ [cell, cell, ...], ... ] }]
//   cell 为 number 时按数字写入，否则按文本(inlineStr)。

(function () {
  "use strict";

  // ---- CRC32 ----
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---- ZIP (store / 无压缩) ----
  function makeZip(files) {
    const enc = new TextEncoder();
    const u16 = (n) => [n & 255, (n >> 8) & 255];
    const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];

    const parts = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);
      const local = new Uint8Array(
        [].concat(
          u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
          u32(crc), u32(data.length), u32(data.length),
          u16(nameBytes.length), u16(0)
        )
      );
      parts.push(local, nameBytes, data);
      const localOffset = offset;
      offset += local.length + nameBytes.length + data.length;

      central.push(
        new Uint8Array(
          [].concat(
            u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
            u32(crc), u32(data.length), u32(data.length),
            u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0),
            u32(localOffset)
          )
        ),
        nameBytes
      );
    }

    let centralSize = 0;
    for (const c of central) centralSize += c.length;
    const centralOffset = offset;

    const eocd = new Uint8Array(
      [].concat(
        u32(0x06054b50), u16(0), u16(0),
        u16(files.length), u16(files.length),
        u32(centralSize), u32(centralOffset), u16(0)
      )
    );

    const all = parts.concat(central, [eocd]);
    let total = 0;
    for (const a of all) total += a.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const a of all) {
      out.set(a, p);
      p += a.length;
    }
    return out;
  }

  // ---- XML helpers ----
  const enc = new TextEncoder();
  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  // 去除 XML 1.0 非法控制字符
  function clean(s) {
    return String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  }
  function colLetter(n) {
    let s = "";
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }
  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function sheetXml(rows) {
    let x =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] || [];
      const ri = r + 1;
      x += '<row r="' + ri + '">';
      for (let ci = 0; ci < row.length; ci++) {
        const ref = colLetter(ci + 1) + ri;
        const v = row[ci];
        if (v === null || v === undefined || v === "") continue;
        if (isNum(v)) {
          x += '<c r="' + ref + '"><v>' + v + "</v></c>";
        } else {
          x +=
            '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' +
            esc(clean(v)) +
            "</t></is></c>";
        }
      }
      x += "</row>";
    }
    x += "</sheetData></worksheet>";
    return x;
  }

  function build(sheets) {
    sheets = sheets && sheets.length ? sheets : [{ name: "Sheet1", rows: [] }];

    const files = [];

    // [Content_Types].xml
    let ct =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>';
    for (let i = 0; i < sheets.length; i++) {
      ct +=
        '<Override PartName="/xl/worksheets/sheet' + (i + 1) +
        '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
    }
    ct += "</Types>";
    files.push({ name: "[Content_Types].xml", data: enc.encode(ct) });

    // _rels/.rels
    files.push({
      name: "_rels/.rels",
      data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          "</Relationships>"
      ),
    });

    // xl/workbook.xml
    let wb =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>';
    for (let i = 0; i < sheets.length; i++) {
      wb +=
        '<sheet name="' + esc(clean(sheets[i].name || "Sheet" + (i + 1))) +
        '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
    }
    wb += "</sheets></workbook>";
    files.push({ name: "xl/workbook.xml", data: enc.encode(wb) });

    // xl/_rels/workbook.xml.rels
    let rels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
    for (let i = 0; i < sheets.length; i++) {
      rels +=
        '<Relationship Id="rId' + (i + 1) +
        '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' +
        (i + 1) + '.xml"/>';
    }
    rels += "</Relationships>";
    files.push({ name: "xl/_rels/workbook.xml.rels", data: enc.encode(rels) });

    // worksheets
    for (let i = 0; i < sheets.length; i++) {
      files.push({
        name: "xl/worksheets/sheet" + (i + 1) + ".xml",
        data: enc.encode(sheetXml(sheets[i].rows || [])),
      });
    }

    return makeZip(files);
  }

  window.TKXlsx = { build };
})();

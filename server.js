require("dotenv").config();
const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const XLSX = require("xlsx");
const fs = require("fs");
const axios = require("axios");
const cheerio = require("cheerio");
const { OpenAI } = require("openai");
const path = require("path");
const urlModule = require("url");

const app = express();
const upload = multer({ dest: "uploads/" });
const PORT = 3000;

app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ----------------------- Persistent Storage -----------------------
const DATA_FILE = path.join(__dirname, "chunks.json");
let CHUNKS = [];

// Load previous chunks
if (fs.existsSync(DATA_FILE)) {
  CHUNKS = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

// Save chunks to file
function saveChunks() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(CHUNKS, null, 2));
}

// ----------------------- Helper Functions -----------------------
function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dot / (magA * magB);
}

// Split text into chunks
function chunkText(text, chunkSize = 1500, overlap = 300) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize - overlap) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

// Batch embeddings (rate-limit safe)
async function embedTextsBatch(texts, batchSize = 50) {
  const embeddings = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const res = await Promise.all(
      batch.map((text) =>
        openai.embeddings.create({
          model: "text-embedding-3-small",
          input: text,
        })
      )
    );
    embeddings.push(...res.map((r) => r.data[0].embedding));
    await new Promise((r) => setTimeout(r, 50)); // small delay to avoid RPM limit
  }
  return embeddings;
}

// Process text into chunks + embeddings
async function processText(text, source = "file") {
  const chunks = chunkText(text);
  const embeddings = await embedTextsBatch(chunks, 50);

  const processed = chunks.map((chunk, i) => ({
    id: `${source}_${Date.now()}_${i}`,
    text: chunk,
    embedding: embeddings[i],
  }));

  CHUNKS.push(...processed);
  saveChunks();

  return processed.length;
}

// ----------------------- File Upload -----------------------
app.post("/upload-file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const filePath = req.file.path;
    const ext = req.file.originalname.split(".").pop().toLowerCase();
    let text = "";

    if (ext === "pdf") {
      const data = await pdfParse(fs.readFileSync(filePath));
      text = data.text;
    } else if (ext === "xlsx" || ext === "xls" || ext === "csv") {
      const workbook = XLSX.readFile(filePath);
      text = workbook.SheetNames
        .map((name) => XLSX.utils.sheet_to_csv(workbook.Sheets[name]))
        .join("\n");
    } else if (ext === "docx") {
      const result = await mammoth.extractRawText({ path: filePath });
      text = result.value;
    } else if (ext === "txt" || ext === "log" || ext === "report") {
      text = fs.readFileSync(filePath, "utf8");
    } else {
      return res.status(400).json({ error: "Unsupported file type" });
    }

    if (!text.trim()) return res.status(400).json({ error: "No text extracted" });

    const chunksCount = await processText(text, ext.toUpperCase());
    fs.unlinkSync(filePath); // cleanup uploaded file
    res.json({ message: "File indexed", chunks: chunksCount, type: ext });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "File processing error" });
  }
});

// ----------------------- Website Upload (single page) -----------------------
app.post("/upload-website", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "No URL provided" });

    const { data } = await axios.get(url);
    const $ = cheerio.load(data);
    const text = $("body").text().replace(/\s+/g, " ").trim();

    if (!text) return res.status(400).json({ error: "No content found on website" });

    const chunksCount = await processText(text, "website");
    res.json({ message: "Website indexed", chunks: chunksCount, url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Website processing error" });
  }
});

// ----------------------- Full Website Upload (crawl all pages) -----------------------
async function crawlWebsite(baseUrl, visited = new Set(), maxPages = 100) {
  const pages = [];

  async function crawl(url) {
    if (visited.has(url) || pages.length >= maxPages) return;
    visited.add(url);

    try {
      const { data } = await axios.get(url);
      const $ = cheerio.load(data);

      // Extract title + headings + body
      const title = $("title").text();
      const headings = $("h1, h2, h3").map((i, el) => $(el).text()).get().join("\n");
      const bodyText = $("body").text().replace(/\s+/g, " ").trim();
      const text = [title, headings, bodyText].filter(Boolean).join("\n\n");

      if (text) pages.push({ url, text });

      // Internal links
      $("a[href]").each((i, el) => {
        let link = $(el).attr("href");
        if (!link) return;
        const resolved = urlModule.resolve(baseUrl, link.split("#")[0]);
        if (resolved.startsWith(baseUrl)) crawl(resolved);
      });
    } catch (err) {
      console.error("Failed to fetch:", url, err.message);
    }
  }

  await crawl(baseUrl);
  return pages;
}

app.post("/upload-full-website", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "No URL provided" });

    const pages = await crawlWebsite(url, new Set(), 100);
    if (!pages.length) return res.status(400).json({ error: "No content found" });

    let totalChunks = 0;
    for (const page of pages) {
      const chunksCount = await processText(page.text, page.url);
      totalChunks += chunksCount;
    }

    res.json({ message: "Full website indexed", pagesIndexed: pages.length, totalChunks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Website processing error" });
  }
});

// ----------------------- Ask Questions -----------------------
app.post("/ask", async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: "No question provided" });
    if (CHUNKS.length === 0) return res.status(400).json({ error: "No data indexed" });

    const qEmbed = (await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: question,
    })).data[0].embedding;

    const ranked = CHUNKS.map((c) => ({ ...c, score: cosineSimilarity(qEmbed, c.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    const context = ranked.map((c) => c.text).join("\n\n");

    const answer = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a highly skilled and professional data assistant.
- Analyze and compare datasets from Excel, CSV, PDF, Word, and websites.
- Provide insights, highlight trends, detect anomalies accurately.
- Only use uploaded data; do not invent information.
- Answer questions concisely in readable paragraphs or tables.
- Reference the source of each insight when possible.
- If data does not contain the answer, politely state so.`,
        },
        { role: "user", content: `Answer the question using this context:\n\n${context}\n\nQ: ${question}` },
      ],
    });

    res.json({
      answer: answer.choices[0].message.content,
      sources: ranked.map((r) => r.id),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "QA error" });
  }
});

// ----------------------- Start Server -----------------------
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));

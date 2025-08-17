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

const app = express();
const upload = multer({ dest: "uploads/" });
const PORT = 3000;

app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ----------------------- Persistent Storage -----------------------
const DATA_FILE = path.join(__dirname, "chunks.json");
let CHUNKS = [];

// Load previous chunks from file if exists
if (fs.existsSync(DATA_FILE)) {
  CHUNKS = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

// Save chunks to file
function saveChunks() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(CHUNKS, null, 2));
}

// ----------------------- Helper Functions -----------------------
function chunkText(text, chunkSize = 500, overlap = 100) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize - overlap) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

async function embedTexts(texts) {
  const embeddings = [];
  for (const text of texts) {
    const res = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });
    embeddings.push(res.data[0].embedding);
  }
  return embeddings;
}

function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dot / (magA * magB);
}

async function processText(text, source = "file") {
  const chunks = chunkText(text);
  const embeddings = await embedTexts(chunks);
  const processed = chunks.map((chunk, i) => ({
    id: `${source}_${Date.now()}_${i}`,
    text: chunk,
    embedding: embeddings[i],
  }));
  CHUNKS.push(...processed); // append to existing chunks
  saveChunks();             // persist to disk
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

// ----------------------- Website Upload -----------------------
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

    // Rank chunks by similarity
    const ranked = CHUNKS.map((c) => ({
      ...c,
      score: cosineSimilarity(qEmbed, c.embedding),
    }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    const context = ranked.map((c) => c.text).join("\n\n");

    const answer = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful document assistant." },
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

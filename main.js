const express = require("express");
const ytdl = require("@distube/ytdl-core");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");

// Set environment variable to disable update checks
process.env.YTDL_NO_UPDATE = 'true';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Add rate limiting to prevent 429 errors from YouTube
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // limit each IP to 10 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after a minute"
});

// Apply rate limiting to all endpoints
app.use(apiLimiter);

// Function to parse Netscape cookies.txt format into the new format expected by ytdl-core
function parseCookiesFile(filePath) {
  try {
    const cookiesContent = fs.readFileSync(filePath, 'utf8');
    const cookieLines = cookiesContent.split('\n');
    
    const cookies = [];
    
    for (const line of cookieLines) {
      // Skip comments and empty lines
      if (line.startsWith('#') || line.trim() === '') continue;
      
      // Parse each cookie line
      const parts = line.split('\t');
      if (parts.length >= 7) {
        // Format for new ytdl-core cookie structure
        cookies.push({
          name: parts[5],
          value: parts[6],
          domain: parts[0],
          path: parts[2],
          expires: parseInt(parts[4]),
          httpOnly: false,
          secure: parts[3] === 'TRUE'
        });
      }
    }
    
    return cookies;
  } catch (error) {
    console.error("Error parsing cookies file:", error);
    return [];
  }
}

// Load cookies from file
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');
let cookies = [];

// Try to load cookies at startup
try {
  cookies = parseCookiesFile(COOKIES_PATH);
  console.log(`Loaded ${cookies.length} cookies from cookies.txt`);
} catch (error) {
  console.error("Failed to load cookies at startup:", error);
}

// Endpoint to reload cookies
app.post("/reload-cookies", (req, res) => {
  try {
    cookies = parseCookiesFile(COOKIES_PATH);
    res.json({ success: true, message: `Reloaded ${cookies.length} cookies` });
  } catch (error) {
    res.status(500).json({ error: "Failed to reload cookies" });
  }
});

// Simple health check endpoint that doesn't hit YouTube's API
app.get("/health", (req, res) => {
  res.json({ 
    status: "OK", 
    cookiesLoaded: cookies.length > 0,
    cookieCount: cookies.length
  });
});

// Cache for video info to reduce API calls
const videoCache = new Map();
const CACHE_TTL = 3600000; // 1 hour in milliseconds

// Helper function to get video info with caching
async function getCachedVideoInfo(videoId, options) {
  const cacheKey = `${videoId}_${JSON.stringify(options)}`;
  
  // Check if we have a valid cache entry
  if (videoCache.has(cacheKey)) {
    const cachedData = videoCache.get(cacheKey);
    // Check if cache is still valid
    if (Date.now() - cachedData.timestamp < CACHE_TTL) {
      return cachedData.info;
    }
    // Cache expired, remove it
    videoCache.delete(cacheKey);
  }
  
  // Fetch fresh data
  const info = await ytdl.getInfo(`https://music.youtube.com/watch?v=${videoId}`, options);
  
  // Store in cache
  videoCache.set(cacheKey, {
    info,
    timestamp: Date.now()
  });
  
  return info;
}

app.get("/mp3/:videoId", async (req, res) => {
  try {
    const videoId = req.params.videoId;
    if (!videoId) {
      return res.status(400).json({ error: "Missing video ID" });
    }

    // Options for ytdl-core with authentication cookies
    const options = {};
    
    // Add cookies to request if available (using new format)
    if (cookies.length > 0) {
      options.requestOptions = { cookies: cookies };
    }

    // Fetch video information with caching
    const info = await getCachedVideoInfo(videoId, options);

    // Filter formats for audio-only streams
    const audioFormats = info.formats.filter(format => format.mimeType?.includes("audio") && format.audioCodec);

    if (audioFormats.length === 0) {
      return res.status(404).json({ error: "No audio stream found" });
    }

    res.json({
      videoDetails: info.videoDetails,
      audioFormats: audioFormats
    });
  } catch (error) {
    console.error(error);
    if (error.message.includes('sign in')) {
      res.status(401).json({ error: "Authentication required. Please check your cookies.txt file." });
    } else if (error.statusCode === 429) {
      res.status(429).json({ error: "YouTube rate limit exceeded. Please try again later." });
    } else {
      res.status(500).json({ error: "Failed to fetch video streaming data", message: error.message });
    }
  }
});

// Endpoint to stream audio directly with exponential backoff retry
app.get("/stream/:videoId", async (req, res) => {
  try {
    const videoId = req.params.videoId;
    if (!videoId) {
      return res.status(400).json({ error: "Missing video ID" });
    }

    // Options for ytdl-core with authentication cookies
    const options = {};
    
    // Add cookies to request if available
    if (cookies.length > 0) {
      options.requestOptions = { cookies: cookies };
    }

    // Get info with caching to find the best audio format
    const info = await getCachedVideoInfo(videoId, options);
    
    // Get the highest quality audio-only format
    const audioFormat = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
    
    if (!audioFormat) {
      return res.status(404).json({ error: "No suitable audio format found" });
    }

    // Set headers
    res.header('Content-Type', audioFormat.mimeType || 'audio/webm');
    if (audioFormat.contentLength) {
      res.header('Content-Length', audioFormat.contentLength);
    }
    
    // Stream the audio with retry logic built into ytdl
    ytdl(`https://music.youtube.com/watch?v=${videoId}`, { 
      format: audioFormat,
      requestOptions: options.requestOptions
    }).pipe(res);
    
  } catch (error) {
    console.error(error);
    if (error.message?.includes('sign in')) {
      res.status(401).json({ error: "Authentication required. Please check your cookies.txt file." });
    } else if (error.statusCode === 429) {
      res.status(429).json({ error: "YouTube rate limit exceeded. Please try again later." });
    } else {
      res.status(500).json({ error: "Failed to stream audio", message: error.message });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Authentication status: ${cookies.length > 0 ? `${cookies.length} cookies loaded` : 'No cookies loaded'}`);
  console.log(`Update check disabled: ${process.env.YTDL_NO_UPDATE === 'true'}`);
});
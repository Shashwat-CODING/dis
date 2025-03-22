const express = require("express");
const ytdl = require("@distube/ytdl-core");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

// Basic middleware
app.use(cors());
app.use(express.json());

// Cookie handling
const COOKIES_PATH = path.join(__dirname, 'cookies.json');
let agent = null;

// Create agent from JSON cookies array
function createAgentFromJSON(cookiesArray) {
  try {
    // Validate cookie array
    if (!Array.isArray(cookiesArray)) {
      console.error("Invalid cookies format: Not an array");
      return false;
    }
    
    agent = ytdl.createAgent(cookiesArray);
    console.log(`Created agent with ${cookiesArray.length} cookies`);
    return true;
  } catch (error) {
    console.error("Failed to create agent from JSON:", error);
    return false;
  }
}

// Load cookies from file with better error handling
function loadCookiesFromFile() {
  try {
    if (fs.existsSync(COOKIES_PATH)) {
      const cookiesContent = fs.readFileSync(COOKIES_PATH, 'utf8');
      
      // Handle potential JSON formatting issues
      let cookiesArray;
      try {
        // Try parsing as JSON first
        cookiesArray = JSON.parse(cookiesContent);
        return createAgentFromJSON(cookiesArray);
      } catch (jsonError) {
        console.error("Error parsing cookies.json:", jsonError.message);
        
        // Try to fix common JSON formatting issues
        try {
          // Try adding missing closing brackets if needed
          const fixedContent = cookiesContent.trim() + 
            (cookiesContent.trim().endsWith(']') ? '' : ']');
          
          cookiesArray = JSON.parse(fixedContent);
          console.warn("Fixed JSON formatting issues in cookies.json");
          return createAgentFromJSON(cookiesArray);
        } catch (fixError) {
          console.error("Could not fix JSON format:", fixError.message);
          return false;
        }
      }
    } else {
      console.warn("cookies.json file not found");
      return false;
    }
  } catch (error) {
    console.error("Failed to load cookies from file:", error);
    return false;
  }
}

// Load cookies from environment variables or file
function loadCookies() {
  // First try to load from JSON environment variable
  if (process.env.YOUTUBE_COOKIES) {
    try {
      const cookiesArray = JSON.parse(process.env.YOUTUBE_COOKIES);
      if (createAgentFromJSON(cookiesArray)) {
        return true;
      }
    } catch (error) {
      console.error("Failed to parse cookies from YOUTUBE_COOKIES env variable:", error);
    }
  }
  
  // Try to load from file as fallback
  return loadCookiesFromFile();
}

// Load cookies at startup
loadCookies();

// Endpoint to reload cookies
app.post("/reload-cookies", (req, res) => {
  const success = loadCookies();
  if (success) {
    res.json({ status: "success", message: "Cookies reloaded successfully" });
  } else {
    res.status(500).json({ status: "error", message: "Failed to reload cookies" });
  }
});

// MP3 info endpoint
app.get("/mp3/:videoId", async (req, res) => {
  const videoId = req.params.videoId;
  if (!videoId) {
    return res.status(400).json({ error: "Missing video ID" });
  }

  if (!agent) {
    return res.status(401).json({ error: "No cookies loaded. Age-restricted videos require authentication." });
  }

  try {
    // Get video info with proper agent
    const info = await ytdl.getInfo(`https://youtube.com/watch?v=${videoId}`, { agent });
    
    // Get audio formats
    const audioFormats = info.formats
      .filter(format => format.mimeType?.includes("audio") && format.audioCodec)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    if (audioFormats.length === 0) {
      return res.status(404).json({ error: "No audio stream found" });
    }

    // Get best audio format
    const bestFormat = audioFormats[0];

    // Return audio data
    res.json({
      videoDetails: {
        videoId: info.videoDetails.videoId,
        title: info.videoDetails.title,
        lengthSeconds: info.videoDetails.lengthSeconds,
        author: info.videoDetails.author?.name || null
      },
      recommendedFormat: bestFormat,
      audioFormats: audioFormats
    });
  } catch (error) {
    console.error("MP3 info error:", error.message);
    if (error.message?.includes('sign in') || error.message?.includes('confirm your age')) {
      res.status(401).json({ error: "Authentication required for age-restricted content - check your cookies" });
    } else if (error.statusCode === 429 || error.message?.includes('too many requests')) {
      res.status(429).json({ error: "Rate limited by YouTube - try again later" });
    } else {
      res.status(500).json({ error: "Failed to fetch audio data: " + error.message });
    }
  }
});

// Simple health check endpoint
app.get("/health", (req, res) => {
  res.json({ 
    status: "OK", 
    agentCreated: agent !== null,
    cookiesLoaded: agent !== null
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Agent created: ${agent !== null}`);
});
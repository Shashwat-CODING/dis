const express = require("express");
const ytdl = require("@distube/ytdl-core");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const HttpsProxyAgent = require("https-proxy-agent").HttpsProxyAgent;

// Set environment variable to disable update checks
process.env.YTDL_NO_UPDATE = 'true';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Cache for video info
const videoCache = new Map();
const CACHE_TTL = 3600000; // 1 hour in milliseconds

// Proxy management
const PROXY_API_URL = "https://backendmix.vercel.app/ips";
let proxyList = [];
let currentProxyIndex = 0;
let lastProxyRefresh = 0;
const PROXY_REFRESH_INTERVAL = 30 * 60 * 1000; // 30 minutes

// Function to fetch proxy list
async function refreshProxyList() {
  try {
    const now = Date.now();
    if (now - lastProxyRefresh > PROXY_REFRESH_INTERVAL || proxyList.length === 0) {
      console.log("Refreshing proxy list...");
      const response = await axios.get(PROXY_API_URL);
      if (response.data && Array.isArray(response.data.proxies) && response.data.proxies.length > 0) {
        proxyList = response.data.proxies;
        currentProxyIndex = 0;
        lastProxyRefresh = now;
        console.log(`Successfully loaded ${proxyList.length} proxies`);
      } else {
        console.error("Invalid proxy list format received");
      }
    }
  } catch (error) {
    console.error("Failed to refresh proxy list:", error.message);
  }
}

// Get the next proxy from the list
function getNextProxy() {
  if (proxyList.length === 0) return null;
  
  const proxy = proxyList[currentProxyIndex];
  currentProxyIndex = (currentProxyIndex + 1) % proxyList.length;
  return proxy;
}

// Create a proxy agent for HTTP/HTTPS requests
function createProxyAgent(proxy) {
  if (!proxy) return null;
  return new HttpsProxyAgent(`http://${proxy}`);
}

// Function to parse Netscape cookies.txt format
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

// Fetch video info with proxy rotation and retries
async function fetchVideoInfo(videoId, maxRetries = proxyList.length) {
  let attempts = 0;
  let lastError = null;
  
  // Ensure proxy list is loaded
  if (proxyList.length === 0) {
    await refreshProxyList();
  }
  
  while (attempts < maxRetries) {
    const proxy = getNextProxy();
    const proxyAgent = createProxyAgent(proxy);
    
    console.log(`Attempt ${attempts + 1}/${maxRetries} using proxy: ${proxy}`);
    
    try {
      // Options for ytdl-core with authentication cookies and proxy
      const options = {
        requestOptions: {}
      };
      
      // Add cookies if available
      if (cookies.length > 0) {
        options.requestOptions.cookies = cookies;
      }
      
      // Add proxy if available
      if (proxyAgent) {
        options.requestOptions.agent = proxyAgent;
      }
      
      // Fetch video information
      return await ytdl.getInfo(`https://music.youtube.com/watch?v=${videoId}`, options);
    } catch (error) {
      lastError = error;
      
      // If it's a rate limit error, try another proxy
      if (error.statusCode === 429) {
        console.log(`Rate limit hit with proxy ${proxy}, trying next proxy...`);
        attempts++;
        // Small delay before trying next proxy
        await new Promise(resolve => setTimeout(resolve, 500));
      } else if (error.statusCode === 403 || error.statusCode === 401) {
        // Authentication error - cookie issue, don't retry with different proxy
        console.error("Authentication error:", error.message);
        throw error;
      } else {
        // Other errors, try next proxy
        console.error(`Error with proxy ${proxy}:`, error.message);
        attempts++;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }
  
  // If we've exhausted all proxies without success
  console.error(`Failed after ${attempts} attempts with different proxies`);
  throw lastError || new Error("Failed to fetch video info after multiple attempts");
}

// Helper function to get video info with caching and proxy rotation
async function getCachedVideoInfo(videoId) {
  const cacheKey = videoId;
  
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
  
  // Fetch fresh data with proxy rotation
  const info = await fetchVideoInfo(videoId);
  
  // Store in cache
  videoCache.set(cacheKey, {
    info,
    timestamp: Date.now()
  });
  
  return info;
}

// Reload cookies endpoint
app.post("/reload-cookies", (req, res) => {
  try {
    cookies = parseCookiesFile(COOKIES_PATH);
    res.json({ success: true, message: `Reloaded ${cookies.length} cookies` });
  } catch (error) {
    res.status(500).json({ error: "Failed to reload cookies" });
  }
});

// Refresh proxies endpoint
app.post("/refresh-proxies", async (req, res) => {
  try {
    await refreshProxyList();
    res.json({ 
      success: true, 
      message: `Refreshed proxy list`, 
      count: proxyList.length,
      proxies: proxyList
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to refresh proxies" });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ 
    status: "OK", 
    cookiesLoaded: cookies.length > 0,
    cookieCount: cookies.length,
    proxiesLoaded: proxyList.length > 0,
    proxyCount: proxyList.length
  });
});

// MP3 info endpoint
app.get("/mp3/:videoId", async (req, res) => {
  try {
    const videoId = req.params.videoId;
    if (!videoId) {
      return res.status(400).json({ error: "Missing video ID" });
    }

    // Fetch video information with caching and proxy rotation
    const info = await getCachedVideoInfo(videoId);

    // Filter formats for audio-only streams
    const audioFormats = info.formats.filter(format => 
      format.mimeType?.includes("audio") && format.audioCodec
    );

    if (audioFormats.length === 0) {
      return res.status(404).json({ error: "No audio stream found" });
    }

    res.json({
      videoDetails: info.videoDetails,
      audioFormats: audioFormats
    });
  } catch (error) {
    console.error(error);
    if (error.message?.includes('sign in')) {
      res.status(401).json({ error: "Authentication required. Please check your cookies.txt file." });
    } else if (error.statusCode === 429) {
      res.status(429).json({ error: "YouTube rate limit exceeded. All proxies failed." });
    } else {
      res.status(500).json({ error: "Failed to fetch video streaming data", message: error.message });
    }
  }
});

// Stream endpoint
app.get("/stream/:videoId", async (req, res) => {
  try {
    const videoId = req.params.videoId;
    if (!videoId) {
      return res.status(400).json({ error: "Missing video ID" });
    }

    // Get info with caching to find the best audio format
    const info = await getCachedVideoInfo(videoId);
    
    // Get the highest quality audio-only format
    const audioFormat = ytdl.chooseFormat(info.formats, { 
      quality: 'highestaudio', 
      filter: 'audioonly' 
    });
    
    if (!audioFormat) {
      return res.status(404).json({ error: "No suitable audio format found" });
    }

    // Set appropriate headers
    res.header('Content-Type', audioFormat.mimeType || 'audio/webm');
    if (audioFormat.contentLength) {
      res.header('Content-Length', audioFormat.contentLength);
    }
    
    // Get a fresh proxy for streaming
    const proxy = getNextProxy();
    const proxyAgent = createProxyAgent(proxy);
    
    // Options for streaming
    const options = {
      format: audioFormat,
      requestOptions: {}
    };
    
    // Add cookies if available
    if (cookies.length > 0) {
      options.requestOptions.cookies = cookies;
    }
    
    // Add proxy if available
    if (proxyAgent) {
      options.requestOptions.agent = proxyAgent;
      console.log(`Streaming using proxy: ${proxy}`);
    }
    
    // Stream the audio
    ytdl(`https://music.youtube.com/watch?v=${videoId}`, options).pipe(res);
    
  } catch (error) {
    console.error(error);
    if (error.message?.includes('sign in')) {
      res.status(401).json({ error: "Authentication required. Please check your cookies.txt file." });
    } else if (error.statusCode === 429) {
      res.status(429).json({ error: "YouTube rate limit exceeded. All proxies failed." });
    } else {
      res.status(500).json({ error: "Failed to stream audio", message: error.message });
    }
  }
});

// Initialize the server
async function startServer() {
  // Initial proxy list load
  await refreshProxyList();
  
  // Start the server
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Authentication: ${cookies.length > 0 ? `${cookies.length} cookies loaded` : 'No cookies loaded'}`);
    console.log(`Proxies: ${proxyList.length > 0 ? `${proxyList.length} proxies loaded` : 'No proxies loaded'}`);
  });
}

// Start the server
startServer();
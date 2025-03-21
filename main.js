const express = require("express");
const ytdl = require("@distube/ytdl-core");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");

// Disable update checks for faster startup
process.env.YTDL_NO_UPDATE = 'true';

const app = express();
const PORT = process.env.PORT || 3001;

// Performance optimizations
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Add rate limiting to prevent overwhelming YouTube's servers
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // limit each IP to 20 requests per windowMs
  message: { error: "Too many requests from this IP, please try again later" }
});

// Apply rate limiting to the video endpoints
app.use("/mp3", apiLimiter);
app.use("/stream", apiLimiter);

// Improved cache with longer TTL and prefetching
const videoCache = new Map();
const formatCache = new Map();
const CACHE_TTL = 24 * 3600000; // 24 hours
const MAX_CACHE_SIZE = 1000;

// Load cookies only once at startup
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');
let cookies = [];

// Parse cookies from file - optimized version
function parseCookiesFile(filePath) {
  try {
    const cookiesContent = fs.readFileSync(filePath, 'utf8');
    if (!cookiesContent.trim()) return [];
    
    return cookiesContent.split('\n')
      .filter(line => line.trim() && !line.startsWith('#'))
      .map(line => {
        const parts = line.split('\t');
        if (parts.length < 7) return null;
        
        return {
          name: parts[5],
          value: parts[6],
          domain: parts[0],
          path: parts[2],
          expires: parseInt(parts[4]),
          httpOnly: false,
          secure: parts[3] === 'TRUE'
        };
      })
      .filter(Boolean);
  } catch (error) {
    console.error("Error parsing cookies file:", error);
    return [];
  }
}

// Try to load cookies at startup
try {
  cookies = parseCookiesFile(COOKIES_PATH);
  console.log(`Loaded ${cookies.length} cookies from cookies.txt`);
} catch (error) {
  console.error("Failed to load cookies at startup:", error);
}

// Enhanced base options with proper headers to avoid detection
const getBaseOptions = () => ({
  requestOptions: {
    cookies: cookies.length > 0 ? cookies : undefined,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://music.youtube.com/',
      'Origin': 'https://music.youtube.com'
    }
  }
});

// Cleanup old cache entries
function cleanupCache() {
  if (videoCache.size > MAX_CACHE_SIZE) {
    const now = Date.now();
    let oldestTime = now;
    let oldestKey = null;
    
    while (videoCache.size > MAX_CACHE_SIZE * 0.8) {
      videoCache.forEach((value, key) => {
        if (value.timestamp < oldestTime) {
          oldestTime = value.timestamp;
          oldestKey = key;
        }
      });
      
      if (oldestKey) {
        videoCache.delete(oldestKey);
        oldestKey = null;
        oldestTime = now;
      } else {
        break;
      }
    }
  }
}

// Add retry logic for fetching video info
async function fetchWithRetry(videoId, maxRetries = 3) {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      const options = getBaseOptions();
      return await ytdl.getInfo(`https://music.youtube.com/watch?v=${videoId}`, options);
    } catch (error) {
      if ((error.statusCode === 429 || error.message?.includes('too many requests')) && retries < maxRetries - 1) {
        const delay = Math.pow(2, retries) * 1000; // Exponential backoff
        console.log(`Rate limited for ${videoId}, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        retries++;
      } else {
        throw error;
      }
    }
  }
}

// Optimized video info fetching with enhanced caching and retry logic
async function getCachedVideoInfo(videoId) {
  const cacheKey = videoId;
  
  if (videoCache.has(cacheKey)) {
    const cachedData = videoCache.get(cacheKey);
    if (Date.now() - cachedData.timestamp < CACHE_TTL) {
      return cachedData.info;
    }
    videoCache.delete(cacheKey);
  }
  
  const info = await fetchWithRetry(videoId);
  
  videoCache.set(cacheKey, {
    info,
    timestamp: Date.now()
  });
  
  if (videoCache.size > MAX_CACHE_SIZE) {
    cleanupCache();
  }
  
  return info;
}

// Find the best audio format and cache the decision
function getBestAudioFormat(info, videoId) {
  const formatCacheKey = videoId;
  
  if (formatCache.has(formatCacheKey)) {
    const format = formatCache.get(formatCacheKey);
    const now = Date.now();
    
    if (now - format.timestamp < CACHE_TTL) {
      return format.audioFormat;
    }
    formatCache.delete(formatCacheKey);
  }
  
  const audioFormat = ytdl.chooseFormat(info.formats, { 
    quality: 'highestaudio', 
    filter: 'audioonly' 
  });
  
  if (audioFormat) {
    formatCache.set(formatCacheKey, {
      audioFormat,
      timestamp: Date.now()
    });
  }
  
  return audioFormat;
}

// Helper function to check if a format is likely to work reliably
function isReliableFormat(format) {
  // Check if format has crucial properties that make it more likely to be playable
  return (
    format &&
    format.url && 
    format.contentLength && 
    !format.isHLS && // HLS streams tend to be less reliable
    !format.isDashMPD // DASH manifests need additional processing
  );
}

// Add throttling to request queue
const requestQueue = [];
let isProcessing = false;
const THROTTLE_DELAY = 500; // ms between requests

async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  
  isProcessing = true;
  const { task, resolve, reject } = requestQueue.shift();
  
  try {
    const result = await task();
    resolve(result);
  } catch (error) {
    reject(error);
  } finally {
    isProcessing = false;
    setTimeout(processQueue, THROTTLE_DELAY);
  }
}

function addToQueue(task) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ task, resolve, reject });
    if (!isProcessing) processQueue();
  });
}

// MP3 info endpoint with more reliable audio streams
app.get("/mp3/:videoId", async (req, res) => {
  const videoId = req.params.videoId;
  if (!videoId) {
    return res.status(400).json({ error: "Missing video ID" });
  }

  try {
    // Add the request to the queue to throttle
    const info = await addToQueue(() => getCachedVideoInfo(videoId));
    
    // Get all possible audio formats
    const regularAudioFormats = info.formats
      .filter(format => format.mimeType?.includes("audio") && format.audioCodec)
      .map(format => ({
        ...format,
        formatType: "regular",
        isReliable: isReliableFormat(format)
      }));
    
    // Get adaptive formats if available
    const adaptiveAudioFormats = info.player_response?.streamingData?.adaptiveFormats
      ? info.player_response.streamingData.adaptiveFormats
          .filter(format => format.mimeType?.includes("audio") || 
                           (format.audioQuality && !format.qualityLabel))
          .map(format => ({
            ...format,
            formatType: "adaptive",
            isReliable: isReliableFormat(format)
          }))
      : [];
    
    // Combine and sort formats by reliability first, then by bitrate
    const allAudioFormats = [...regularAudioFormats, ...adaptiveAudioFormats]
      .sort((a, b) => {
        // First sort by reliability
        if (a.isReliable && !b.isReliable) return -1;
        if (!a.isReliable && b.isReliable) return 1;
        
        // Then sort by bitrate (higher first)
        return (b.bitrate || 0) - (a.bitrate || 0);
      });

    if (allAudioFormats.length === 0) {
      return res.status(404).json({ error: "No audio stream found" });
    }

    // Get recommended format
    const recommendedFormat = allAudioFormats.find(format => format.isReliable) || allAudioFormats[0];

    // Return audio data
    res.json({
      videoDetails: {
        videoId: info.videoDetails.videoId,
        title: info.videoDetails.title,
        lengthSeconds: info.videoDetails.lengthSeconds,
        author: info.videoDetails.author?.name || null,
        isPrivate: info.videoDetails.isPrivate,
        isLiveContent: info.videoDetails.isLiveContent
      },
      recommendedFormat,
      audioFormats: allAudioFormats
    });
  } catch (error) {
    console.error("MP3 info error:", error.message);
    if (error.message?.includes('sign in')) {
      res.status(401).json({ error: "Authentication required - check your cookies" });
    } else if (error.statusCode === 429 || error.message?.includes('too many requests')) {
      res.status(429).json({ error: "Rate limited by YouTube - try again later" });
    } else {
      res.status(500).json({ error: "Failed to fetch audio data: " + error.message });
    }
  }
});

// Optimized streaming endpoint
app.get("/stream/:videoId", async (req, res) => {
  const videoId = req.params.videoId;
  if (!videoId) {
    return res.status(400).json({ error: "Missing video ID" });
  }

  try {
    // Use caching for format info with throttling
    const info = await addToQueue(() => getCachedVideoInfo(videoId));
    const audioFormat = getBestAudioFormat(info, videoId);
    
    if (!audioFormat) {
      return res.status(404).json({ error: "No suitable audio format found" });
    }

    // Set appropriate headers
    res.header('Content-Type', audioFormat.mimeType || 'audio/webm');
    if (audioFormat.contentLength) {
      res.header('Content-Length', audioFormat.contentLength);
    }
    
    // Create stream with reused options
    const options = {
      ...getBaseOptions(),
      format: audioFormat,
      range: req.headers.range // Support range requests for seeking
    };
    
    // Stream directly to response
    const stream = ytdl(`https://music.youtube.com/watch?v=${videoId}`, options);
    
    // Handle errors in the stream
    stream.on('error', (err) => {
      console.error(`Stream error for ${videoId}:`, err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Streaming error: " + err.message });
      }
    });
    
    // Add more comprehensive error handling for streams
    stream.on('response', (response) => {
      if (response.statusCode >= 400) {
        console.warn(`Stream received HTTP ${response.statusCode} for ${videoId}`);
      }
    });
    
    stream.pipe(res);
    
  } catch (error) {
    console.error("Stream error:", error.message);
    if (error.message?.includes('sign in')) {
      res.status(401).json({ error: "Authentication required - check your cookies" });
    } else if (error.statusCode === 429 || error.message?.includes('too many requests')) {
      res.status(429).json({ error: "Rate limited by YouTube - try again later" });
    } else {
      res.status(500).json({ error: "Failed to stream audio: " + error.message });
    }
  }
});

// Fast health check endpoint with more diagnostics
app.get("/health", (req, res) => {
  // Check cookie expiration
  const now = Date.now();
  const validCookies = cookies.filter(cookie => !cookie.expires || cookie.expires > now/1000);
  
  res.json({ 
    status: "OK", 
    cookiesLoaded: cookies.length > 0,
    cookieCount: cookies.length,
    validCookieCount: validCookies.length,
    cacheSize: videoCache.size,
    formatCacheSize: formatCache.size,
    queueSize: requestQueue.length,
    isProcessingQueue: isProcessing,
    uptime: process.uptime()
  });
});

// Check cookies validity periodically
function checkCookiesValidity() {
  const now = Date.now() / 1000; // Convert to seconds for comparison with cookie expiry
  const expiredCookies = cookies.filter(cookie => cookie.expires && cookie.expires <= now);
  
  if (expiredCookies.length > 0) {
    console.warn(`Warning: ${expiredCookies.length} cookies have expired. Consider updating your cookies.txt file.`);
  }
}

// Initialize the server with optimizations
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Cookies: ${cookies.length > 0 ? `${cookies.length} loaded` : 'None'}`);
  
  // Check cookies validity on startup
  checkCookiesValidity();
  
  // Schedule periodic checks for cookie validity
  setInterval(checkCookiesValidity, 3600000); // Check every hour
});
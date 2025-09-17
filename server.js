require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const { MongoClient, ObjectId } = require('mongodb');
const OpenAI = require('openai');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcrypt');

const app = express();
const port = process.env.PORT || 3001;

// Environment Variable Validation
const requiredEnvVars = ['MONGODB_URI', 'SESSION_SECRET', 'OPENAI_API_KEY', 'RECRUITER_USER', 'RECRUITER_PASS_HASH', 'FRONTEND_URL'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
if (missingEnvVars.length > 0) {
  console.error(`FATAL ERROR: Missing required environment variables: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

let db;
let mongoClient;

// Function to connect to MongoDB with retry logic
async function connectToMongoDB() {
  const maxRetries = 5;
  let retries = 0;

  while (retries < maxRetries) {
    try {
      mongoClient = new MongoClient(MONGODB_URI, {
        // Explicitly enable TLS for MongoDB Atlas
        tls: true,
        serverSelectionTimeoutMS: 5000 // Timeout after 5 seconds
      });
      await mongoClient.connect();
      db = mongoClient.db();
      console.log('Connected to MongoDB');
      return;
    } catch (err) {
      retries++;
      console.error(`MongoDB connection attempt ${retries}/${maxRetries} failed:`, err);
      if (retries === maxRetries) {
        console.error('Max retries reached. Could not connect to MongoDB.');
        return;
      }
      // Wait 5 seconds before retrying
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Middleware
app.use(cors({
  // Ensure FRONTEND_URL is set to https://recruitr.onrender.com in Render's environment variables
  origin: process.env.FRONTEND_URL, // Use the variable from .env
  credentials: true
}));
app.use(express.json());

// Initialize session middleware after the database is connected
connectToMongoDB().then(() => {
  app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      client: mongoClient,
      dbName: 'recruitr',
      collectionName: 'sessions'
    }),
    cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 24 * 60 * 60 * 1000, sameSite: 'lax' }
  }));
  // Start the server only after the database and session store are ready
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}).catch(err => {
  console.error("Failed to connect to MongoDB and set up session store. Exiting.", err);
  process.exit(1);
});

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} request to ${req.url}`);
  next();
});

app.post('/api/login', async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not connected. Please try again later.' });
  }

  const { username, password } = req.body;

  if (username === RECRUITER_USER) {
    if (await bcrypt.compare(password, RECRUITER_PASS_HASH)) {
      req.session.user = { username };
      return res.json({ success: true, username });
    }
  }
  
  res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/api/verify-session', (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not connected. Please try again later.' });
  }

  if (req.session && req.session.user && req.session.user.username === RECRUITER_USER) {
    return res.json({ success: true, username: req.session.user.username });
  }
  res.status(401).json({ error: 'Not authenticated' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ error: 'Could not log out, please try again.' });
    }
    res.clearCookie('connect.sid'); // The default name for express-session cookie
    res.status(200).json({ message: 'Logged out successfully' });
  });
});

function requireAuth(req, res, next) {
  if (!db) {
    return res.status(503).json({ error: 'Database not connected. Please try again later.' });
  }

  if (req.session && req.session.user && req.session.user.username === RECRUITER_USER) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.pdf' && ext !== '.docx') {
      return cb(new Error('Only PDF and DOCX files are allowed'));
    }
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

async function parseResumeWithAI(text) {
  const prompt = `
    From the following resume text, extract the candidate's name, a list of their skills, a summary of their work experience, and a summary of their education.
    Format the output as a JSON object with keys: "candidateName", "skills", "experience", "education".
    The "skills" value should be an array of strings.
    The "experience" value should be an array of strings, with each string representing a job or project.
    The "education" value should be an array of strings, with each string representing a degree or certification.

    Resume Text:
    ---
    ${text}
    ---
  `;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: "json_object" },
    });

    const content = completion.choices[0].message.content;
    if (!content) {
      throw new Error('OpenAI returned an empty response.');
    }

    const parsedData = JSON.parse(content);
    
    // Basic validation of the parsed data structure
    if (!parsedData.candidateName || !Array.isArray(parsedData.skills) || !Array.isArray(parsedData.experience) || !Array.isArray(parsedData.education)) {
      throw new Error('OpenAI returned a malformed JSON object.');
    }

    return parsedData;
  } catch (error) {
    console.error('Error calling OpenAI API:', error);
    throw new Error('Failed to parse resume with AI.');
  }
}

const SKILL_LIST = [
  'python', 'javascript', 'sql', 'java', 'react', 'node.js', 'html', 'css',
  'typescript', 'angular', 'vue', 'mongodb', 'mysql', 'postgresql', 'aws',
  'docker', 'kubernetes', 'git', 'linux', 'c++', 'c#', 'php', 'ruby',
  'excel', 'tableau', 'power bi', 'r', 'matlab', 'tensorflow', 'pytorch',
  'agile', 'scrum', 'jira', 'jenkins', 'azure', 'gcp', 'graphql', 'rest',
  'communication', 'teamwork', 'problem solving', 'leadership', 'management',
  'customer service', 'technical support', 'data analysis', 'project management'
];

function extractCandidateName(text) {
  const lines = text.split('\n').slice(0, 10);
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.length > 50) continue;
    
    const skipWords = ['resume', 'cv', 'curriculum', 'vitae', 'profile', 'contact'];
    if (skipWords.some(word => trimmedLine.toLowerCase().includes(word))) continue;
    
    const words = trimmedLine.split(' ').filter(w => w.length > 1);
    if (words.length >= 2 && words.length <= 4) {
      const namePattern = words.every(w => 
        /^[A-Z][a-z]+$/.test(w) || /^[A-Z][a-z]+[-'][A-Z][a-z]+$/.test(w)
      );
      if (namePattern) return trimmedLine;
    }
  }
  
  return 'Unknown Candidate';
}

async function parseResume(fileBuffer, fileType, originalFilename) {
  let text;
  try {
    if (fileType === '.pdf') {
      const data = await pdf(fileBuffer);
      text = data.text;
    } else if (fileType === '.docx') {
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      text = result.value;
    } else {
      throw new Error('Unsupported file type');
    }
  } catch (error) {
    console.error(`Error extracting text from ${fileType}:`, error);
    throw error;
  }

  console.log('Extracted text:', text);

  // Use AI for more robust parsing
  const aiParsedData = await parseResumeWithAI(text);

  // You can still use regex as a fallback or to supplement the AI data
  const regexSkills = SKILL_LIST.filter(skill => text.toLowerCase().includes(skill));
  const allSkills = [...new Set([...aiParsedData.skills, ...regexSkills])];

  const candidateName = extractCandidateName(text);
  console.log('Extracted candidate name:', candidateName);

  return {
    candidateName: aiParsedData.candidateName || candidateName,
    skills: allSkills.sort(),
    experience: aiParsedData.experience,
    education: aiParsedData.education,
    rawText: text,
    originalFilename
  };
}

app.post('/api/upload-resume', upload.single('resume'), async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not connected. Please try again later.' });
  }

  if (!req.file) {
    console.log('No file uploaded or invalid file type');
    return res.status(400).json({ error: 'No file uploaded or invalid file type' });
  }

  try {
    console.log(`Processing file: ${req.file.originalname}`);
    const fileType = path.extname(req.file.originalname).toLowerCase();
    const parsedData = await parseResume(req.file.buffer, fileType, req.file.originalname);

    const candidate = {
      fileName: req.file.originalname,
      parsedData,
      createdAt: new Date(),
      chatHistory: []
    };
    const result = await db.collection('candidates').insertOne(candidate);
    const candidateId = result.insertedId.toString();

    const response = {
      message: 'Resume uploaded successfully',
      fileName: req.file.originalname,
      parsedData,
      candidateId
    };
    console.log(`Sending response:`, response);
    res.json(response);
  } catch (error) {
    console.error('Error parsing resume:', error);
    res.status(500).json({ error: `Failed to parse resume: ${error.message}` });
  }
});

app.post('/api/chat', async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not connected. Please try again later.' });
  }

  const { candidateId, message } = req.body;
  if (!candidateId || !message) {
    return res.status(400).json({ error: 'Candidate ID and message required' });
  }
  
  try {
    const candidate = await db.collection('candidates').findOne({ _id: new ObjectId(candidateId) });
    if (!candidate) {
      return res.status(404).json({ error: 'Candidate data not found' });
    }
    
    const chatHistory = candidate.chatHistory || [];
    const skills = candidate.parsedData.skills || [];
    
    let responseText;
    
    if (message.toLowerCase().includes('thank you') || message.toLowerCase().includes('thanks')) {
      responseText = "You're welcome! Do you have any other questions for me?";
    }
    else if (message.toLowerCase().includes('salary') || message.toLowerCase().includes('compensation')) {
      responseText = "That's a great question. Compensation details are typically discussed with a recruiter in the next stage. Is there a particular salary range you are looking for?";
    }
    else if (message.toLowerCase().includes('when') && message.toLowerCase().includes('hear')) {
      responseText = "We typically review applications within 5-7 business days. I'll make a note to prioritize your application.";
    }
    else if (skills.some(skill => message.toLowerCase().includes(skill.toLowerCase()))) {
      const mentionedSkill = skills.find(skill => message.toLowerCase().includes(skill.toLowerCase()));
      responseText = `That's great experience with ${mentionedSkill}. Can you describe a specific project where you applied this skill?`;
    }
    else if (message.toLowerCase().includes('position') || message.toLowerCase().includes('job') || message.toLowerCase().includes('role')) {
      responseText = "This role involves [briefly describe role]. What specific aspects of the position are you most interested in?";
    }
    else if (message.split(' ').length < 10) {
      responseText = "Could you elaborate a bit more? I'd love to understand your background in more detail.";
    }
    else if (skills.length > 0) {
      const discussedSkills = new Set();
      chatHistory.forEach(msg => {
        if (msg.sender === 'AI') {
          skills.forEach(skill => {
            if (msg.text.toLowerCase().includes(skill.toLowerCase())) {
              discussedSkills.add(skill);
            }
          });
        }
      });
      
      const undiscussedSkills = skills.filter(skill => !discussedSkills.has(skill));
      if (undiscussedSkills.length > 0) {
        responseText = `Thanks for sharing that. I notice you also have experience with ${undiscussedSkills[0]}. Could you tell me more about that?`;
      } else {
        responseText = "Thank you for providing that information. Is there anything else you'd like to know about the company or the role?";
      }
    } else {
      responseText = "Thanks for your response. What are you looking for in your next role?";
    }
    
    await db.collection('candidates').updateOne(
      { _id: new ObjectId(candidateId) },
      { 
        $push: {
          chatHistory: {
            $each: [
              { sender: 'User', text: message, timestamp: new Date() },
              { sender: 'AI', text: responseText, timestamp: new Date() }
            ]
          }
        }
      }
    );
    
    res.json({ response: responseText });
  } catch (error) {
    console.error('Chat endpoint error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/candidates/:id', requireAuth, async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not connected. Please try again later.' });
  }

  try {
    const candidateId = req.params.id;
    const candidate = await db.collection('candidates').findOne(
      { _id: new ObjectId(candidateId) }
    );
    
    if (!candidate) {
      return res.status(404).json({ error: 'Candidate not found' });
    }
    
    res.json({ candidate });
  } catch (error) {
    console.error('Error fetching candidate details:', error);
    res.status(500).json({ error: 'Failed to fetch candidate details' });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: db ? 'OK' : 'Database not connected' });
});

const gracefulShutdown = (signal) => {
  console.log(`${signal} received. Closing connections...`);
  if (mongoClient) {
    mongoClient.close().then(() => {
      console.log('MongoDB connection closed.');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
};

// Handle process termination gracefully
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
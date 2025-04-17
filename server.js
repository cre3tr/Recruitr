require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const { MongoClient, ObjectId } = require('mongodb');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcrypt'); // Added bcrypt

const app = express();
const port = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/recruitr';
const SESSION_SECRET = process.env.SESSION_SECRET || 'changeme';

// MongoDB setup
let db;
MongoClient.connect(MONGODB_URI, { useUnifiedTopology: true })
  .then(client => {
    db = client.db();
    console.log('Connected to MongoDB');
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

// Middleware
app.use(cors({
  origin: 'http://localhost:5173', // Frontend port; adjust as needed
  credentials: true
}));
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGODB_URI }),
  cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

// Replace hardcoded credentials with env vars
const RECRUITER_USER = process.env.RECRUITER_USER || 'recruiter';
const RECRUITER_PASS_HASH = process.env.RECRUITER_PASS_HASH; // Store hashed password in env

// Improved login endpoint
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  // For MVP with stored hash
  if (username === RECRUITER_USER) {
    // For development without bcrypt setup yet
    if (process.env.NODE_ENV === 'development' && password === 'password') {
      req.session.user = { username };
      return res.json({ success: true, username });
    }
    
    // For production with proper password hashing
    if (RECRUITER_PASS_HASH && await bcrypt.compare(password, RECRUITER_PASS_HASH)) {
      req.session.user = { username };
      return res.json({ success: true, username });
    }
  }
  
  res.status(401).json({ error: 'Invalid credentials' });
});

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.user && req.session.user.username === RECRUITER_USER) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

// Set up file storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.pdf' && ext !== '.docx') {
      return cb(new Error('Only PDF and DOCX files are allowed'));
    }
    cb(null, true);
  }
});

// Expanded skill list for matching
const SKILL_LIST = [
  'python', 'javascript', 'sql', 'java', 'react', 'node.js', 'html', 'css',
  'typescript', 'angular', 'vue', 'mongodb', 'mysql', 'postgresql', 'aws',
  'docker', 'kubernetes', 'git', 'linux', 'c++', 'c#', 'php', 'ruby',
  'excel', 'tableau', 'power bi', 'r', 'matlab', 'tensorflow', 'pytorch',
  'agile', 'scrum', 'jira', 'jenkins', 'azure', 'gcp', 'graphql', 'rest',
  'communication', 'teamwork', 'problem solving', 'leadership', 'management',
  'customer service', 'technical support', 'data analysis', 'project management'
];

// Enhanced name extraction function
function extractCandidateName(text) {
  // Look for common name patterns at the top of resumes
  const lines = text.split('\n').slice(0, 10);
  
  // Try to find a name-like pattern in the first few lines
  for (const line of lines) {
    const trimmedLine = line.trim();
    // Skip empty lines and very long lines (likely not a name)
    if (!trimmedLine || trimmedLine.length > 50) continue;
    
    // Skip lines with common resume section headers
    const skipWords = ['resume', 'cv', 'curriculum', 'vitae', 'profile', 'contact'];
    if (skipWords.some(word => trimmedLine.toLowerCase().includes(word))) continue;
    
    // A name is likely 2-3 words without special characters
    const words = trimmedLine.split(' ').filter(w => w.length > 1);
    if (words.length >= 2 && words.length <= 4) {
      // Check if it looks like a name (first letter uppercase, rest lowercase)
      const namePattern = words.every(w => 
        /^[A-Z][a-z]+$/.test(w) || /^[A-Z][a-z]+[-'][A-Z][a-z]+$/.test(w)
      );
      if (namePattern) return trimmedLine;
    }
  }
  
  return 'Unknown Candidate';
}

// Improved parseResume function with name extraction
async function parseResume(filePath, fileType) {
  let text;
  try {
    if (fileType === '.pdf') {
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdf(dataBuffer);
      text = data.text;
    } else if (fileType === '.docx') {
      const result = await mammoth.extractRawText({ path: filePath });
      text = result.value;
    }
  } catch (error) {
    console.error(`Error extracting text from ${fileType}:`, error);
    throw error;
  }

  console.log('Extracted text:', text);

  // Basic parsing logic
  const skills = SKILL_LIST.filter(skill => text.toLowerCase().includes(skill));
  console.log('Skills matched:', skills);

  // Fallback: Extract skills from common sections (e.g., "Skills:", "Technical Skills:")
  const skillsSectionMatch = text.match(/(?:skills|technical skills|key skills)[:\n](.*?)(?=\n\n|\n[A-Z])/is);
  let additionalSkills = [];
  if (skillsSectionMatch) {
    const skillsSection = skillsSectionMatch[1].toLowerCase();
    additionalSkills = SKILL_LIST.filter(skill => skillsSection.includes(skill));
    console.log('Additional skills from section:', additionalSkills);
  } else {
    console.log('No skills section found');
  }

  // Combine skills and remove duplicates
  const allSkills = [...new Set([...skills, ...additionalSkills])];

  // More flexible regex for experience
  const experience = text.match(/(engineer|developer|manager|analyst|consultant|intern|associate|lead|senior|junior|specialist|support|administrator)\s*[\w\s]*(?:\d{4}\s*-\s*\d{4}|\d{4}\s*-\s*present|\d{4})/gi) || [];
  console.log('Experience matched:', experience);

  // More flexible regex for education
  const education = text.match(/(bachelor|bs|ms|phd|master|mba|diploma|certificate|degree)\s*(?:in|of)?\s*[\w\s]*(?:university|college|institute|school|academy)?/gi) || [];
  console.log('Education matched:', education);

  // Extract candidate name
  const candidateName = extractCandidateName(text);
  console.log('Extracted candidate name:', candidateName);

  return {
    candidateName,
    skills: allSkills,
    experience: experience.map(e => e.trim()),
    education: education.map(e => e.trim()),
    rawText: text
  };
}

// API endpoint for resume upload
app.post('/api/upload-resume', upload.single('resume'), async (req, res) => {
  if (!req.file) {
    console.log('No file uploaded or invalid file type');
    return res.status(400).json({ error: 'No file uploaded or invalid file type' });
  }

  try {
    console.log(`Processing file: ${req.file.filename}`);
    const fileType = path.extname(req.file.filename).toLowerCase();
    const parsedData = await parseResume(req.file.path, fileType);

    // Store parsed data in MongoDB
    const candidate = {
      fileName: req.file.filename,
      parsedData,
      createdAt: new Date(),
      chatHistory: []
    };
    const result = await db.collection('candidates').insertOne(candidate);
    const candidateId = result.insertedId.toString();

    const response = {
      message: 'Resume uploaded successfully',
      fileName: req.file.filename,
      parsedData,
      candidateId
    };
    console.log(`Sending response:`, response);
    res.json(response);
  } catch (error) {
    console.error('Error parsing resume:', error);
    res.status(500).json({ error: 'Failed to parse resume' });
  }
});

// Enhanced chat endpoint with better context awareness
app.post('/api/chat', async (req, res) => {
  const { candidateId, message } = req.body;
  if (!candidateId || !message) {
    return res.status(400).json({ error: 'Candidate ID and message required' });
  }
  
  try {
    const candidate = await db.collection('candidates').findOne({ _id: new ObjectId(candidateId) });
    if (!candidate) {
      return res.status(404).json({ error: 'Candidate data not found' });
    }
    
    // Get chat history for context
    const chatHistory = candidate.chatHistory || [];
    const skills = candidate.parsedData.skills || [];
    
    // Generate more context-aware responses
    let responseText;
    
    // Check message content for specific patterns
    if (message.toLowerCase().includes('thank you') || message.toLowerCase().includes('thanks')) {
      responseText = "You're welcome! Do you have any questions about the next steps in our process?";
    }
    else if (message.toLowerCase().includes('salary') || message.toLowerCase().includes('compensation')) {
      responseText = "Great question about compensation. Our recruiter will discuss the salary range during the follow-up call. Can you share your salary expectations?";
    }
    else if (message.toLowerCase().includes('when') && message.toLowerCase().includes('hear')) {
      responseText = "We typically review applications within 5-7 business days. I'll make a note to prioritize your application.";
    }
    // If discussing experience with a skill we've identified
    else if (skills.some(skill => message.toLowerCase().includes(skill.toLowerCase()))) {
      const mentionedSkill = skills.find(skill => message.toLowerCase().includes(skill.toLowerCase()));
      responseText = `That's great experience with ${mentionedSkill}. Can you describe a specific project where you applied this skill?`;
    }
    // Detect if candidate is asking about the position
    else if (message.toLowerCase().includes('position') || message.toLowerCase().includes('job') || message.toLowerCase().includes('role')) {
      responseText = "This position involves working with our core technology team. What specific aspects of the role are you most interested in?";
    }
    // Detect if this is a short answer that needs follow-up
    else if (message.split(' ').length < 10) {
      responseText = "Could you elaborate a bit more? I'd love to understand your background in more detail.";
    }
    // Default response based on skills
    else if (skills.length > 0) {
      // Rotate through skills we haven't discussed yet
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
        responseText = "Thank you for providing that information. Is there anything specific about the company or position you'd like to know?";
      }
    } else {
      responseText = "Thanks for your response. What are you looking for in your next role?";
    }
    
    // Save chat message and response to candidate's chatHistory
    await db.collection('candidates').updateOne(
      { _id: new ObjectId(candidateId) },
      { 
        $push: { 
          chatHistory: { 
            sender: 'User', 
            text: message, 
            timestamp: new Date() 
          }, 
          chatHistory: { 
            sender: 'AI', 
            text: responseText, 
            timestamp: new Date() 
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

// Add endpoint to get detailed candidate data
app.get('/api/candidates/:id', requireAuth, async (req, res) => {
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

// Serve static files (optional)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Start server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
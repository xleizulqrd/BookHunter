import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import multer from 'multer';
import sqlite3 from 'sqlite3';
import crypto from 'crypto';
import axios from 'axios';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const SECRET_KEY = process.env.SECRET_KEY || crypto.randomBytes(64).toString('hex');
const JWT_EXPIRY = '30d';
const BCRYPT_ROUNDS = 12;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-r1:7b';

class DatabaseManager {
  constructor() {
    this.db = null;
    this.init();
  }

  init() {
    try {
      this.db = new sqlite3.Database('bookhunter.db');
      this.db.serialize(() => {
        this.createTables();
      });
    } catch (err) {
      process.exit(1);
    }
  }

  createTables() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        nickname TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        passwordHash TEXT NOT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        originalName TEXT,
        size INTEGER,
        chunkCount INTEGER,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS preferences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER UNIQUE NOT NULL,
        genres TEXT DEFAULT '[]',
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_books_userId ON books(userId)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_preferences_userId ON preferences(userId)`);
  }

  getUserById(id) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM users WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  getUserByEmail(email) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM users WHERE email = ?', [email], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  getUserByNickname(nickname) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM users WHERE nickname = ?', [nickname], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  createUser({ email, nickname, name, passwordHash }) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO users (email, nickname, name, passwordHash) VALUES (?, ?, ?, ?)',
        [email, nickname, name, passwordHash],
        function(err) {
          if (err) reject(err);
          else {
            db.getUserById(this.lastID).then(resolve).catch(reject);
          }
        }
      );
    });
  }

  getUserBooks(userId) {
    return new Promise((resolve, reject) => {
      this.db.all(`
        SELECT id, title, createdAt, 
               LENGTH(content) as size,
               (LENGTH(content) - LENGTH(REPLACE(content, '\n\n', '')) + 1) as chunkCount
        FROM books 
        WHERE userId = ? 
        ORDER BY createdAt DESC
      `, [userId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  getBook(id, userId) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM books WHERE id = ? AND userId = ?', [id, userId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  createBook({ userId, title, content, originalName, size }) {
    const chunkCount = content.split(/\n\n+/).length;
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO books (userId, title, content, originalName, size, chunkCount) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, title, content, originalName, size || content.length, chunkCount],
        function(err) {
          if (err) reject(err);
          else {
            db.getBook(this.lastID, userId).then(resolve).catch(reject);
          }
        }
      );
    });
  }

  renameBook(id, userId, newTitle) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE books SET title = ? WHERE id = ? AND userId = ?',
        [newTitle, id, userId],
        function(err) {
          if (err) reject(err);
          else resolve({ changes: this.changes });
        }
      );
    });
  }

  deleteBook(id, userId) {
    return new Promise((resolve, reject) => {
      this.db.run('DELETE FROM books WHERE id = ? AND userId = ?', [id, userId], function(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes });
      });
    });
  }

  getUserPreferences(userId) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM preferences WHERE userId = ?', [userId], (err, row) => {
        if (err) {
          reject(err);
        } else if (!row) {
          resolve({ genres: [] });
        } else {
          try {
            const genres = row.genres ? JSON.parse(row.genres) : [];
            resolve({ genres });
          } catch (e) {
            resolve({ genres: [] });
          }
        }
      });
    });
  }

  saveUserPreferences(userId, { genres }) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT id FROM preferences WHERE userId = ?', [userId], (err, row) => {
        if (err) {
          reject(err);
          return;
        }

        const genresJson = JSON.stringify(genres || []);
        const now = new Date().toISOString();

        if (!row) {
          this.db.run(
            'INSERT INTO preferences (userId, genres, createdAt, updatedAt) VALUES (?, ?, ?, ?)',
            [userId, genresJson, now, now],
            function(err) {
              if (err) reject(err);
              else resolve({ changes: this.changes });
            }
          );
        } else {
          this.db.run(
            'UPDATE preferences SET genres = ?, updatedAt = ? WHERE userId = ?',
            [genresJson, now, userId],
            function(err) {
              if (err) reject(err);
              else resolve({ changes: this.changes });
            }
          );
        }
      });
    });
  }
}

const db = new DatabaseManager();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/plain' || path.extname(file.originalname).toLowerCase() === '.txt') {
      cb(null, true);
    } else {
      cb(new Error('Разрешены только текстовые файлы (.txt)'));
    }
  }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use(cors({ 
  credentials: true, 
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.static(__dirname));

function verifyToken(req, res, next) {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ success: false, message: 'Не авторизован' });
  }
  
  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    req.userId = decoded.id;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Неверный токен' });
  }
}

app.get('/api/auth', async (req, res) => {
  try {
    const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.json({ success: true, user: null });
    }
    
    const decoded = jwt.verify(token, SECRET_KEY);
    const user = await db.getUserById(decoded.id);
    
    if (!user) {
      res.clearCookie('token');
      return res.json({ success: true, user: null });
    }
    
    res.json({ 
      success: true,
      user: { 
        id: user.id, 
        email: user.email, 
        nickname: user.nickname,
        name: user.name,
        createdAt: user.createdAt
      } 
    });
  } catch (err) {
    res.clearCookie('token');
    res.json({ success: true, user: null });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { email, nickname, name, password } = req.body;
    
    if (!email || !nickname || !name || !password) {
      return res.status(400).json({ success: false, message: 'Все поля обязательны' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Пароль должен быть не менее 6 символов' });
    }
    
    const existingEmail = await db.getUserByEmail(email.toLowerCase().trim());
    if (existingEmail) {
      return res.status(400).json({ success: false, message: 'Email уже зарегистрирован' });
    }
    
    const existingNickname = await db.getUserByNickname(nickname.trim());
    if (existingNickname) {
      return res.status(400).json({ success: false, message: 'Никнейм уже занят' });
    }
    
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    
    const user = await db.createUser({
      email: email.toLowerCase().trim(),
      nickname: nickname.trim(),
      name: name.trim(),
      passwordHash: hashedPassword
    });
    
    const token = jwt.sign({ id: user.id }, SECRET_KEY, { expiresIn: JWT_EXPIRY });
    
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      path: '/'
    });
    
    res.json({
      success: true,
      message: 'Аккаунт успешно создан',
      token,
      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        name: user.name
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Ошибка при регистрации' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email и пароль обязательны' });
    }
    
    let user = await db.getUserByEmail(email.toLowerCase().trim());
    if (!user) {
      user = await db.getUserByNickname(email.trim());
    }
    
    if (!user) {
      return res.status(401).json({ success: false, message: 'Неверные учетные данные' });
    }
    
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, message: 'Неверные учетные данные' });
    }
    
    const token = jwt.sign({ id: user.id }, SECRET_KEY, { expiresIn: JWT_EXPIRY });
    
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      path: '/'
    });
    
    res.json({
      success: true,
      message: 'Вход выполнен успешно',
      token,
      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        name: user.name
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Ошибка при входе' });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'Вы вышли из системы' });
});

app.get('/api/books', verifyToken, async (req, res) => {
  try {
    const books = await db.getUserBooks(req.userId);
    res.json({ success: true, books });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Ошибка при получении книг' });
  }
});

app.post('/api/books', verifyToken, upload.single('file'), async (req, res) => {
  try {
    const { title } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Файл не загружен' });
    }
    
    if (!title) {
      return res.status(400).json({ success: false, message: 'Название книги обязательно' });
    }
    
    const content = req.file.buffer.toString('utf-8');
    
    if (content.length < 100) {
      return res.status(400).json({ success: false, message: 'Файл слишком маленький или пустой' });
    }
    
    const book = await db.createBook({
      userId: req.userId,
      title: title.trim(),
      content,
      originalName: req.file.originalname,
      size: req.file.size
    });
    
    res.json({
      success: true,
      message: 'Книга успешно добавлена',
      book
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Ошибка при добавлении книги' });
  }
});

app.put('/api/books/:id', verifyToken, async (req, res) => {
  try {
    const { title } = req.body;
    
    if (!title) {
      return res.status(400).json({ success: false, message: 'Название книги обязательно' });
    }
    
    const book = await db.getBook(req.params.id, req.userId);
    
    if (!book) {
      return res.status(404).json({ success: false, message: 'Книга не найдена' });
    }
    
    await db.renameBook(req.params.id, req.userId, title.trim());
    
    res.json({ success: true, message: 'Книга переименована' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Ошибка при переименовании книги' });
  }
});

app.get('/api/books/:id/content', verifyToken, async (req, res) => {
  try {
    const book = await db.getBook(req.params.id, req.userId);
    
    if (!book) {
      return res.status(404).json({ success: false, message: 'Книга не найдена' });
    }
    
    const chunks = book.content
      .split(/\n\n+/)
      .filter(c => c.trim())
      .map((text, index) => ({ 
        id: index + 1,
        text: text.trim()
      }));
    
    res.json({
      success: true,
      bookId: book.id,
      bookTitle: book.title,
      chunks
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Ошибка при получении содержимого' });
  }
});

app.delete('/api/books/:id', verifyToken, async (req, res) => {
  try {
    const book = await db.getBook(req.params.id, req.userId);
    
    if (!book) {
      return res.status(404).json({ success: false, message: 'Книга не найдена' });
    }
    
    await db.deleteBook(req.params.id, req.userId);
    
    res.json({ success: true, message: 'Книга удалена' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Ошибка при удалении книги' });
  }
});

app.get('/api/preferences', verifyToken, async (req, res) => {
  try {
    const prefs = await db.getUserPreferences(req.userId);
    res.json({ success: true, genres: prefs.genres });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Ошибка при получении предпочтений' });
  }
});

app.post('/api/preferences', verifyToken, async (req, res) => {
  try {
    const { genres } = req.body;
    const genresToSave = Array.isArray(genres) ? genres : [];
    await db.saveUserPreferences(req.userId, { genres: genresToSave });
    res.json({ success: true, message: 'Предпочтения сохранены' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Ошибка при сохранении предпочтений' });
  }
});

async function searchRealBooks(query, limit = 5) {
  try {
    const response = await axios.get(`https://openlibrary.org/search.json`, {
      params: {
        q: query,
        limit: limit,
        fields: 'title,author_name,first_publish_year,subject,key'
      }
    });
    
    const books = response.data.docs.map(doc => ({
      title: doc.title || 'Неизвестно',
      author: doc.author_name ? doc.author_name[0] : 'Неизвестен',
      year: doc.first_publish_year || 'Неизвестно',
      genres: doc.subject ? doc.subject.slice(0, 3) : [],
      description: `${doc.title} — книга, опубликованная в ${doc.first_publish_year || 'неизвестном'} году.`,
      coverId: doc.cover_i,
      key: doc.key
    }));
    
    return books;
  } catch (error) {
    return [];
  }
}

app.post('/api/recommendations', verifyToken, async (req, res) => {
  try {
    const { genres = [] } = req.body;
    const prefs = await db.getUserPreferences(req.userId);
    const userGenres = genres.length > 0 ? genres : prefs.genres || [];
    
    let searchQuery = '';
    if (userGenres.length > 0) {
      searchQuery = userGenres.slice(0, 2).join(' ');
    } else {
      searchQuery = 'fiction';
    }
    
    const realBooks = await searchRealBooks(searchQuery, 5);
    
    if (realBooks.length === 0) {
      const fallbackBooks = [
        {
          title: "Война и мир",
          author: "Лев Толстой",
          genres: ["Классическая литература", "Исторический роман"],
          description: "Эпический роман о русском обществе в эпоху Наполеоновских войн.",
          reason: "Величайший роман русской литературы, обязательный к прочтению."
        },
        {
          title: "1984",
          author: "Джордж Оруэлл",
          genres: ["Фантастика", "Антиутопия"],
          description: "Роман-антиутопия о тоталитарном обществе.",
          reason: "Классика антиутопической литературы."
        },
        {
          title: "Мастер и Маргарита",
          author: "Михаил Булгаков",
          genres: ["Классическая литература", "Магический реализм"],
          description: "Мистический роман о визите дьявола в Москву.",
          reason: "Шедевр русской литературы XX века."
        },
        {
          title: "Преступление и наказание",
          author: "Федор Достоевский",
          genres: ["Классическая литература", "Психология"],
          description: "Роман о моральных страданиях студента, совершившего убийство.",
          reason: "Глубокое исследование человеческой психологии."
        },
        {
          title: "Сто лет одиночества",
          author: "Габриэль Гарсиа Маркес",
          genres: ["Классическая литература", "Магический реализм"],
          description: "История семьи Буэндиа на протяжении поколений.",
          reason: "Вершина магического реализма."
        }
      ];
      
      const recommendations = fallbackBooks.map(book => ({
        ...book,
        reason: book.reason || `Рекомендуется для любителей ${userGenres.length > 0 ? userGenres.join(', ') : 'классической литературы'}`
      }));
      
      return res.json({ success: true, recommendations: recommendations.slice(0, 5) });
    }
    
    const recommendations = realBooks.map(book => ({
      title: book.title,
      author: book.author,
      genres: book.genres.length > 0 ? book.genres : userGenres,
      description: book.description,
      year: book.year,
      reason: `Книга "${book.title}" рекомендуется для чтения.${userGenres.length > 0 ? ` Соответствует вашим предпочтениям в жанре ${userGenres.join(', ')}.` : ''}`
    }));
    
    res.json({ success: true, recommendations: recommendations.slice(0, 5) });
  } catch (err) {
    const fallbackBooks = [
      {
        title: "Война и мир",
        author: "Лев Толстой",
        genres: ["Классическая литература", "Исторический роман"],
        description: "Эпический роман о русском обществе в эпоху Наполеоновских войн.",
        reason: "Величайший роман русской литературы."
      },
      {
        title: "1984",
        author: "Джордж Оруэлл",
        genres: ["Фантастика", "Антиутопия"],
        description: "Роман-антиутопия о тоталитарном обществе.",
        reason: "Классика антиутопической литературы."
      }
    ];
    res.json({ success: true, recommendations: fallbackBooks });
  }
});

app.post('/api/chat', verifyToken, async (req, res) => {
  try {
    const { question } = req.body;
    
    if (!question) {
      return res.status(400).json({ success: false, message: 'Вопрос обязателен' });
    }
    
    const prompt = `Ты - умный помощник BookHunter. Отвечай на вопросы пользователя дружелюбно, информативно и развернуто. Ответы давай ИСКЛЮЧИТЕЛЬНО ТОЛЬКО НА РУССКОМ ЯЗЫКЕ.
    
Пользователь спрашивает: ${question}

Дай полезный, интересный и полный ответ. Ответы давай ИСКЛЮЧИТЕЛЬНО ТОЛЬКО НА РУССКОМ ЯЗЫКЕ.`;

    const response = await axios.post(`${OLLAMA_URL}/api/generate`, {
      model: OLLAMA_MODEL,
      prompt: prompt,
      stream: false,
      options: {
        temperature: 0.7,
        max_tokens: 500
      }
    });
    
    res.json({
      success: true,
      answer: response.data.response
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      message: 'Ошибка при обработке вопроса',
      answer: 'Извините, произошла ошибка. Проверьте подключение к Ollama.'
    });
  }
});

app.post('/api/search', verifyToken, async (req, res) => {
  try {
    const { query, topK = 5 } = req.body;
    
    if (!query) {
      return res.status(400).json({ success: false, message: 'Поисковый запрос обязателен' });
    }
    
    const books = await db.getUserBooks(req.userId);
    
    if (books.length === 0) {
      return res.json({
        success: true,
        found: false,
        query,
        fragments: [],
        totalFound: 0,
        message: 'У вас пока нет книг для поиска'
      });
    }
    
    const booksWithContent = [];
    for (const book of books) {
      const fullBook = await db.getBook(book.id, req.userId);
      if (fullBook) booksWithContent.push(fullBook);
    }
    
    const tokenize = (text) => {
      return text.toLowerCase()
        .replace(/[^\w\sа-яё]/gi, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2);
    };
    
    const computeTFIDF = (tokens, allTokens) => {
      const tf = {};
      tokens.forEach(token => {
        tf[token] = (tf[token] || 0) + 1;
      });
      Object.keys(tf).forEach(key => {
        tf[key] = tf[key] / tokens.length;
      });
      return tf;
    };
    
    const cosineSimilarity = (vec1, vec2) => {
      const tokens = new Set([...Object.keys(vec1), ...Object.keys(vec2)]);
      let dotProduct = 0, mag1 = 0, mag2 = 0;
      tokens.forEach(token => {
        const v1 = vec1[token] || 0;
        const v2 = vec2[token] || 0;
        dotProduct += v1 * v2;
        mag1 += v1 * v1;
        mag2 += v2 * v2;
      });
      mag1 = Math.sqrt(mag1);
      mag2 = Math.sqrt(mag2);
      if (mag1 === 0 || mag2 === 0) return 0;
      return dotProduct / (mag1 * mag2);
    };
    
    const queryTokens = tokenize(query);
    const queryVec = computeTFIDF(queryTokens, queryTokens);
    
    let allChunks = [];
    booksWithContent.forEach(book => {
      const paragraphs = book.content.split(/\n\n+/).filter(p => p.trim().length > 20);
      paragraphs.forEach((paragraph, idx) => {
        const chunkTokens = tokenize(paragraph);
        const chunkVec = computeTFIDF(chunkTokens, queryTokens);
        const score = cosineSimilarity(queryVec, chunkVec);
        if (score > 0.1) {
          allChunks.push({
            bookTitle: book.title,
            text: paragraph.trim(),
            location: `Фрагмент ${idx + 1}`,
            score: score
          });
        }
      });
    });
    
    const fragments = allChunks
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    
    res.json({
      success: true,
      found: fragments.length > 0,
      query,
      fragments,
      totalFound: fragments.length
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Ошибка при выполнении поиска' });
  }
});

app.post('/api/ask', verifyToken, async (req, res) => {
  try {
    const { question } = req.body;
    
    if (!question) {
      return res.status(400).json({ success: false, message: 'Вопрос обязателен' });
    }
    
    const books = await db.getUserBooks(req.userId);
    let contextFragments = [];
    
    if (books.length > 0) {
      const booksWithContent = [];
      for (const book of books) {
        const fullBook = await db.getBook(book.id, req.userId);
        if (fullBook) booksWithContent.push(fullBook);
      }
      
      const tokenize = (text) => {
        return text.toLowerCase()
          .replace(/[^\w\sа-яё]/gi, ' ')
          .split(/\s+/)
          .filter(word => word.length > 2);
      };
      
      const computeTFIDF = (tokens, allTokens) => {
        const tf = {};
        tokens.forEach(token => {
          tf[token] = (tf[token] || 0) + 1;
        });
        Object.keys(tf).forEach(key => {
          tf[key] = tf[key] / tokens.length;
        });
        return tf;
      };
      
      const cosineSimilarity = (vec1, vec2) => {
        const tokens = new Set([...Object.keys(vec1), ...Object.keys(vec2)]);
        let dotProduct = 0, mag1 = 0, mag2 = 0;
        tokens.forEach(token => {
          const v1 = vec1[token] || 0;
          const v2 = vec2[token] || 0;
          dotProduct += v1 * v2;
          mag1 += v1 * v1;
          mag2 += v2 * v2;
        });
        mag1 = Math.sqrt(mag1);
        mag2 = Math.sqrt(mag2);
        if (mag1 === 0 || mag2 === 0) return 0;
        return dotProduct / (mag1 * mag2);
      };
      
      const queryTokens = tokenize(question);
      const queryVec = computeTFIDF(queryTokens, queryTokens);
      
      booksWithContent.forEach(book => {
        const paragraphs = book.content.split(/\n\n+/).filter(p => p.trim().length > 20);
        paragraphs.forEach((paragraph, idx) => {
          const chunkTokens = tokenize(paragraph);
          const chunkVec = computeTFIDF(chunkTokens, queryTokens);
          const score = cosineSimilarity(queryVec, chunkVec);
          if (score > 0.15) {
            contextFragments.push({
              bookTitle: book.title,
              text: paragraph.trim(),
              location: `Фрагмент ${idx + 1}`,
              score: score
            });
          }
        });
      });
      
      contextFragments = contextFragments.sort((a, b) => b.score - a.score).slice(0, 5);
    }
    
    let prompt = '';
    let answer = '';
    
    if (contextFragments.length > 0) {
      const context = contextFragments.map(f => 
        `[Из книги "${f.bookTitle}"]: ${f.text}`
      ).join('\n\n');

      prompt = `Ты - помощник, который отвечает на вопросы на основе предоставленных фрагментов из книг.

Фрагменты из книг:
${context}

Вопрос пользователя: ${question}

Дай развернутый ответ на вопрос, ответы давай ИСКЛЮЧИТЕЛЬНО ТОЛЬКО НА РУССКОМ ЯЗЫКЕ, используя информацию из предоставленных фрагментов. Если в фрагментах нет полной информации, дополни ответ своими знаниями, но укажи, что это из внешних источников.
В конце ответа перечисли источники (книги), на которые ты опирался.`;
    } else {
      prompt = `Ты - умный помощник BookHunter. Отвечай на вопросы пользователя дружелюбно, информативно и развернуто.
      
Пользователь спрашивает: ${question}

Дай полезный, интересный и полный ответ. Ответы давай ИСКЛЮЧИТЕЛЬНО ТОЛЬКО НА РУССКОМ ЯЗЫКЕ. Если вопрос связан с книгами или литературой, порекомендуй интересные книги по теме.`;
    }
    
    const response = await axios.post(`${OLLAMA_URL}/api/generate`, {
      model: OLLAMA_MODEL,
      prompt: prompt,
      stream: false,
      options: {
        temperature: 0.7,
        max_tokens: 800
      }
    });
    
    answer = response.data.response;
    
    res.json({
      success: true,
      question,
      answer: answer,
      citationsCount: contextFragments.length,
      citations: contextFragments,
      hasAnswer: true
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      message: 'Ошибка при обработке вопроса',
      answer: 'Извините, произошла ошибка. Проверьте подключение к Ollama и попробуйте снова.'
    });
  }
});

app.get('/api/health', async (req, res) => {
  let ollamaStatus = false;
  try {
    const response = await axios.get(`${OLLAMA_URL}/api/tags`);
    ollamaStatus = response.status === 200;
  } catch (error) {}
  
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ollama: ollamaStatus ? 'connected' : 'disconnected',
    ollamaModel: OLLAMA_MODEL
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {});
// Core application state
const AppState = {
    user: null,
    settings: null,
    isOnline: navigator.onLine,
    dbReady: false
};

// Database configuration using localforage for offline-first architecture
const db = {
    settings: localforage.createInstance({ name: 'settings' }),
    tasks: localforage.createInstance({ name: 'tasks' }),
    notes: localforage.createInstance({ name: 'notes' }),
    files: localforage.createInstance({ name: 'files' }),
    cache: localforage.createInstance({ name: 'cache' })
};

// Database configuration
const DB_CONFIG = {
    name: 'StudyAppDB',
    version: 1,
    stores: {
        notes: { keyPath: 'id', indexes: ['createdAt', 'updatedAt', 'tags'] },
        tasks: { keyPath: 'id', indexes: ['status', 'priority', 'dueDate'] },
        files: { keyPath: 'id', indexes: ['type', 'createdAt'] },
        syncQueue: { keyPath: 'id', indexes: ['type', 'timestamp'] }
    }
};

// IndexedDB Manager
const DBManager = {
    db: null,

    async init() {
        if (this.db) return this.db;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_CONFIG.name, DB_CONFIG.version);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Create object stores and indexes
                Object.entries(DB_CONFIG.stores).forEach(([storeName, config]) => {
                    if (!db.objectStoreNames.contains(storeName)) {
                        const store = db.createObjectStore(storeName, { keyPath: config.keyPath });
                        if (config.indexes) {
                            config.indexes.forEach(indexName => {
                                store.createIndex(indexName, indexName);
                            });
                        }
                    }
                });
            };
        });
    },

    async transaction(storeName, mode = 'readonly') {
        await this.init();
        const tx = this.db.transaction(storeName, mode);
        return tx.objectStore(storeName);
    },

    async get(storeName, id) {
        const store = await this.transaction(storeName);
        return new Promise((resolve, reject) => {
            const request = store.get(id);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    },

    async getAll(storeName, query = null, index = null) {
        const store = await this.transaction(storeName);
        return new Promise((resolve, reject) => {
            const request = index 
                ? store.index(index).getAll(query)
                : store.getAll(query);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    },

    async put(storeName, item) {
        const store = await this.transaction(storeName, 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.put(item);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    },

    async delete(storeName, id) {
        const store = await this.transaction(storeName, 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    },

    async search(storeName, indexName, query) {
        const store = await this.transaction(storeName);
        const index = store.index(indexName);
        const range = IDBKeyRange.bound(query, query + '\uffff');
        
        return new Promise((resolve, reject) => {
            const request = index.getAll(range);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
};

const DBService = {
    dbName: 'studyAppDB',
    version: 1,
    db: null,

    async init() {
        if (!this.db) {
            this.db = await localforage.createInstance({
                name: this.dbName
            });
        }
        return this.db;
    },

    async saveNote(note) {
        const db = await this.init();
        const key = `note_${Date.now()}`;
        await db.setItem(key, {
            ...note,
            id: key,
            timestamp: Date.now(),
            aiAnalysis: await AIService.analyzeNote(note)
        });
        return key;
    },

    async getNotes() {
        const db = await this.init();
        const notes = [];
        await db.iterate((value, key) => {
            if (key.startsWith('note_')) {
                notes.push(value);
            }
        });
        return notes.sort((a, b) => b.timestamp - a.timestamp);
    },

    async saveTask(task) {
        const db = await this.init();
        const key = `task_${Date.now()}`;
        await db.setItem(key, {
            ...task,
            id: key,
            timestamp: Date.now(),
            aiAnalysis: await AIService.analyzeTaskPriority(task)
        });
        return key;
    },

    async getTasks() {
        const db = await this.init();
        const tasks = [];
        await db.iterate((value, key) => {
            if (key.startsWith('task_')) {
                tasks.push(value);
            }
        });
        return tasks.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
    },

    async updateItem(id, data) {
        const db = await this.init();
        const existing = await db.getItem(id);
        if (!existing) throw new Error('Item not found');
        await db.setItem(id, { ...existing, ...data });
    },

    async deleteItem(id) {
        const db = await this.init();
        await db.removeItem(id);
    },

    async searchItems(query) {
        const db = await this.init();
        const items = [];
        const searchRegex = new RegExp(query, 'i');
        
        await db.iterate((value) => {
            if (value.content && searchRegex.test(value.content) ||
                value.title && searchRegex.test(value.title)) {
                items.push(value);
            }
        });
        
        return items;
    }
};

// Core utility functions
const utils = {
    generateId: () => crypto.randomUUID(),
    debounce: (func, wait) => {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    },
    getErrorMessage: (error) => error.message || 'An unknown error occurred',
    isValidJson: (str) => {
        try {
            JSON.parse(str);
            return true;
        } catch (e) {
            return false;
        }
    }
};

// Core security utilities
const security = {
    // Encryption key management
    async getEncryptionKey() {
        let key = await db.settings.getItem('encryptionKey');
        if (!key) {
            // Generate a new encryption key
            key = await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 },
                true,
                ['encrypt', 'decrypt']
            );
            // Store the key securely
            await db.settings.setItem('encryptionKey', key);
        }
        return key;
    },

    // Encrypt data
    async encrypt(data) {
        try {
            const key = await this.getEncryptionKey();
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encodedData = new TextEncoder().encode(JSON.stringify(data));
            
            const encryptedData = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv },
                key,
                encodedData
            );

            return {
                iv: Array.from(iv),
                data: Array.from(new Uint8Array(encryptedData))
            };
        } catch (error) {
            errorHandler.report(error, { context: 'encryption' });
            throw new Error('Encryption failed');
        }
    },

    // Decrypt data
    async decrypt(encryptedData) {
        try {
            const key = await this.getEncryptionKey();
            const iv = new Uint8Array(encryptedData.iv);
            const data = new Uint8Array(encryptedData.data);
            
            const decryptedData = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv },
                key,
                data
            );

            return JSON.parse(new TextDecoder().decode(decryptedData));
        } catch (error) {
            errorHandler.report(error, { context: 'decryption' });
            throw new Error('Decryption failed');
        }
    },

    // Sanitize user input to prevent XSS
    sanitizeInput(input) {
        if (typeof input !== 'string') return input;
        return input
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    },

    // Validate and sanitize URL
    sanitizeUrl(url) {
        try {
            const parsed = new URL(url);
            // Only allow specific protocols
            if (!['https:', 'http:', 'data:'].includes(parsed.protocol)) {
                return '';
            }
            return parsed.toString();
        } catch {
            return '';
        }
    }
};

// Authentication handler using Google OAuth
const auth = {
    init: async () => {
        // Load Google OAuth client library
        await new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = 'https://apis.google.com/js/platform.js';
            script.onload = resolve;
            document.head.appendChild(script);
        });

        gapi.load('auth2', () => {
            gapi.auth2.init({
                client_id: '{{ YOUR_CLIENT_ID }}.apps.googleusercontent.com'
            });
        });
    },
    signIn: async () => {
        try {
            const auth2 = gapi.auth2.getAuthInstance();
            const user = await auth2.signIn();
            AppState.user = {
                id: user.getId(),
                name: user.getBasicProfile().getName(),
                email: user.getBasicProfile().getEmail(),
                imageUrl: user.getBasicProfile().getImageUrl()
            };
            await db.settings.setItem('user', AppState.user);
            events.emit('auth:changed', AppState.user);
            return AppState.user;
        } catch (error) {
            console.error('Auth error:', error);
            throw error;
        }
    },
    signOut: async () => {
        const auth2 = gapi.auth2.getAuthInstance();
        await auth2.signOut();
        AppState.user = null;
        await db.settings.removeItem('user');
        events.emit('auth:changed', null);
    }
};

// Event system for decoupled communication
const events = {
    listeners: {},
    on: (event, callback) => {
        if (!events.listeners[event]) {
            events.listeners[event] = new Set();
        }
        events.listeners[event].add(callback);
    },
    off: (event, callback) => {
        if (events.listeners[event]) {
            events.listeners[event].delete(callback);
        }
    },
    emit: (event, data) => {
        if (events.listeners[event]) {
            events.listeners[event].forEach(callback => callback(data));
        }
    }
};

// Network status monitoring
const network = {
    init: () => {
        window.addEventListener('online', () => {
            AppState.isOnline = true;
            events.emit('network:changed', true);
        });
        window.addEventListener('offline', () => {
            AppState.isOnline = false;
            events.emit('network:changed', false);
        });
    }
};

// Error handling and reporting
const errorHandler = {
    init: () => {
        window.addEventListener('error', (event) => {
            console.error('Global error:', event.error);
            events.emit('error', event.error);
            this.showError(event.error.message || 'An unexpected error occurred');
        });
        window.addEventListener('unhandledrejection', (event) => {
            console.error('Unhandled promise rejection:', event.reason);
            events.emit('error', event.reason);
            this.showError(event.reason.message || 'An unexpected error occurred');
        });
    },
    report: (error, context = {}) => {
        console.error('Error:', error, 'Context:', context);
        events.emit('error', { error, context });
        this.showError(error.message || 'An unexpected error occurred');
    },
    showError: (message) => {
        const notification = document.createElement('div');
        notification.className = 'notification error';
        notification.textContent = message;
        document.body.appendChild(notification);
        
        // Remove notification after 5 seconds
        setTimeout(() => {
            notification.remove();
        }, 5000);
    }
};

// Enhance database operations with encryption
const secureDb = {
    async setItem(storeName, key, value) {
        const encrypted = await security.encrypt(value);
        return db[storeName].setItem(key, encrypted);
    },

    async getItem(storeName, key) {
        const encrypted = await db[storeName].getItem(key);
        if (!encrypted) return null;
        return security.decrypt(encrypted);
    }
};

// UI Components
const UI = {
    renderNavLinks() {
        const navLinks = document.getElementById('nav-links');
        navLinks.innerHTML = `
            <a href="#dashboard" class="nav-link">Dashboard</a>
            <a href="#tasks" class="nav-link">Tasks</a>
            <a href="#notes" class="nav-link">Notes</a>
            <a href="#study" class="nav-link">Study Room</a>
            <a href="#files" class="nav-link">Files</a>
        `;
    },

    renderUserSection() {
        const userSection = document.getElementById('user-section');
        if (AppState.user) {
            userSection.innerHTML = `
                <div class="user-profile">
                    <img src="${security.sanitizeUrl(AppState.user.imageUrl)}" alt="${security.sanitizeInput(AppState.user.name)}" class="avatar">
                    <span>${security.sanitizeInput(AppState.user.name)}</span>
                    <button id="signout-btn">Sign Out</button>
                </div>
            `;
            document.getElementById('signout-btn').addEventListener('click', auth.signOut);
        } else {
            userSection.innerHTML = `
                <button id="signin-btn" class="btn-primary">Sign In with Google</button>
            `;
            document.getElementById('signin-btn').addEventListener('click', auth.signIn);
        }
    },

    renderSidebar() {
        const sidebar = document.getElementById('sidebar');
        sidebar.innerHTML = `
            <div class="sidebar-content">
                <button id="toggle-sidebar" aria-label="Toggle Sidebar">☰</button>
                <nav class="sidebar-nav">
                    <a href="#quick-tasks" class="sidebar-link">Quick Tasks</a>
                    <a href="#recent-notes" class="sidebar-link">Recent Notes</a>
                    <a href="#study-rooms" class="sidebar-link">Study Rooms</a>
                    <a href="#settings" class="sidebar-link">Settings</a>
                </nav>
            </div>
        `;

        document.getElementById('toggle-sidebar').addEventListener('click', () => {
            sidebar.classList.toggle('collapsed');
        });
    },

    renderWelcomeContent() {
        const contentArea = document.getElementById('content-area');
        contentArea.innerHTML = `
            <div class="welcome-screen fade-in">
                <h1>Welcome to ProduLearn Hub</h1>
                <p>Your all-in-one productivity and learning platform</p>
                <div class="feature-grid">
                    <div class="feature-card">
                        <h3>Task Management</h3>
                        <p>Organize and track your tasks efficiently</p>
                    </div>
                    <div class="feature-card">
                        <h3>Smart Notes</h3>
                        <p>Take notes with AI-powered assistance</p>
                    </div>
                    <div class="feature-card">
                        <h3>Study Rooms</h3>
                        <p>Collaborate with peers in real-time</p>
                    </div>
                    <div class="feature-card">
                        <h3>AI Integration</h3>
                        <p>Get intelligent suggestions and summaries</p>
                    </div>
                </div>
            </div>
        `;
    },

    renderStatusBar() {
        const statusBar = document.getElementById('status-bar');
        statusBar.innerHTML = `
            <div class="status-indicators">
                <span class="connection-status ${AppState.isOnline ? 'online' : 'offline'}">
                    ${AppState.isOnline ? 'Online' : 'Offline'}
                </span>
                <span class="sync-status">
                    ${AppState.dbReady ? 'Data Synced' : 'Syncing...'}
                </span>
            </div>
        `;
    },

    renderUserContent(content) {
        // Sanitize content before rendering
        const sanitized = security.sanitizeInput(content);
        const contentArea = document.getElementById('content-area');
        contentArea.innerHTML = sanitized;
    },

    renderUserProfile(user) {
        const userSection = document.getElementById('user-section');
        if (user) {
            // Sanitize user data before display
            const sanitizedName = security.sanitizeInput(user.name);
            const sanitizedImage = security.sanitizeUrl(user.imageUrl);
            userSection.innerHTML = `
                <div class="user-profile">
                    <img src="${sanitizedImage}" alt="${sanitizedName}" class="avatar">
                    <span>${sanitizedName}</span>
                    <button id="signout-btn">Sign Out</button>
                </div>
            `;
            document.getElementById('signout-btn').addEventListener('click', auth.signOut);
        } else {
            userSection.innerHTML = `
                <button id="signin-btn" class="btn-primary">Sign In with Google</button>
            `;
            document.getElementById('signin-btn').addEventListener('click', auth.signIn);
        }
    },

    init() {
        this.renderNavLinks();
        this.renderUserSection();
        this.renderSidebar();
        this.renderWelcomeContent();
        this.renderStatusBar();
    }
};

// Event listeners for UI updates
events.on('auth:changed', () => {
    UI.renderUserSection();
});

events.on('network:changed', () => {
    UI.renderStatusBar();
});

events.on('app:ready', () => {
    UI.init();
});

// Task Management System
const TaskManager = {
    async createTask(task) {
        task.id = utils.generateId();
        task.createdAt = new Date().toISOString();
        task.status = task.status || 'pending';
        
        // Add AI analysis
        const analysis = await AIService.analyzeTaskPriority(task);
        task.priority = analysis.priority;
        task.aiSuggestions = analysis.suggestions;
        
        await secureDb.setItem('tasks', task.id, task);
        events.emit('task:created', task);
        return task;
    },

    async updateTask(taskId, updates) {
        const task = await secureDb.getItem('tasks', taskId);
        if (!task) throw new Error('Task not found');

        const updatedTask = { ...task, ...updates, updatedAt: new Date().toISOString() };
        await secureDb.setItem('tasks', taskId, updatedTask);
        events.emit('task:updated', updatedTask);
        return updatedTask;
    },

    async deleteTask(taskId) {
        await db.tasks.removeItem(taskId);
        events.emit('task:deleted', taskId);
    },

    async getAllTasks() {
        const tasks = [];
        await db.tasks.iterate((value, key) => {
            tasks.push(value);
        });
        return tasks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },

    async getTasksByStatus(status) {
        const allTasks = await this.getAllTasks();
        return allTasks.filter(task => task.status === status);
    }
};

// Enhance TaskManager with offline support
Object.assign(TaskManager, {
    async getAllTasks() {
        try {
            const response = await fetch('/api/tasks');
            if (response.ok) {
                const tasks = await response.json();
                await Promise.all(tasks.map(task => 
                    DBManager.put('tasks', task)
                ));
                return tasks;
            }
        } catch (error) {
            console.log('Fetching from network failed, using local data');
        }

        return await DBManager.getAll('tasks');
    },

    async getTask(id) {
        try {
            const response = await fetch(`/api/tasks/${id}`);
            if (response.ok) {
                const task = await response.json();
                await DBManager.put('tasks', task);
                return task;
            }
        } catch (error) {
            console.log('Fetching from network failed, using local data');
        }

        return await DBManager.get('tasks', id);
    },

    async saveTask(task) {
        // Add to sync queue
        await DBManager.put('syncQueue', {
            id: utils.generateId(),
            type: 'task',
            action: task.id ? 'update' : 'create',
            data: task,
            timestamp: Date.now()
        });

        // Save locally
        if (!task.id) {
            task.id = utils.generateId();
        }
        task.updatedAt = new Date().toISOString();

        // Add AI analysis
        const analysis = await AIService.analyzeTaskPriority(task);
        task.priority = analysis.priority;
        task.aiSuggestions = analysis.suggestions;

        await DBManager.put('tasks', task);

        // Try to sync immediately
        if (navigator.onLine) {
            await this.syncTasks();
        }

        return task;
    },

    async deleteTask(id) {
        // Add to sync queue
        await DBManager.put('syncQueue', {
            id: utils.generateId(),
            type: 'task',
            action: 'delete',
            data: { id },
            timestamp: Date.now()
        });

        // Delete locally
        await DBManager.delete('tasks', id);

        // Try to sync immediately
        if (navigator.onLine) {
            await this.syncTasks();
        }
    },

    async syncTasks() {
        const queue = await DBManager.getAll('syncQueue');
        const taskQueue = queue.filter(item => item.type === 'task');

        for (const item of taskQueue) {
            try {
                let response;
                switch (item.action) {
                    case 'create':
                    case 'update':
                        response = await fetch('/api/tasks', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(item.data)
                        });
                        break;
                    case 'delete':
                        response = await fetch(`/api/tasks/${item.data.id}`, {
                            method: 'DELETE'
                        });
                        break;
                }

                if (response?.ok) {
                    await DBManager.delete('syncQueue', item.id);
                }
            } catch (error) {
                console.error('Sync failed for item:', item);
            }
        }
    }
});

// Task UI Components
UI.renderTaskList = async function() {
    const tasks = await TaskManager.getAllTasks();
    const contentArea = document.getElementById('content-area');
    
    contentArea.innerHTML = `
        <div class="tasks-container">
            <div class="tasks-header">
                <h2>Tasks</h2>
                <button id="new-task-btn" class="btn-primary">New Task</button>
            </div>
            <div class="task-filters">
                <button class="filter-btn active" data-status="all">All</button>
                <button class="filter-btn" data-status="pending">Pending</button>
                <button class="filter-btn" data-status="in-progress">In Progress</button>
                <button class="filter-btn" data-status="completed">Completed</button>
            </div>
            <div class="task-list">
                ${tasks.map(task => UI.renderTaskCard(task)).join('')}
            </div>
        </div>
    `;

    // Event Listeners
    document.getElementById('new-task-btn').addEventListener('click', () => {
        this.showTaskForm();
    });

    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const status = e.target.dataset.status;
            const filteredTasks = status === 'all' 
                ? await TaskManager.getAllTasks()
                : await TaskManager.getTasksByStatus(status);
            
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            
            this.updateTaskList(filteredTasks);
        });
    });

    document.querySelectorAll('.edit-task-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const taskId = e.target.dataset.id;
            const task = await secureDb.getItem('tasks', taskId);
            this.showTaskForm(task);
        });
    });

    document.querySelectorAll('.delete-task-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            if (confirm('Are you sure you want to delete this task?')) {
                const taskId = e.target.dataset.id;
                await TaskManager.deleteTask(taskId);
            }
        });
    });
};

UI.showTaskForm = function(task = null) {
    const dialog = document.createElement('dialog');
    dialog.className = 'task-dialog';
    
    dialog.innerHTML = `
        <form id="task-form">
            <h3>${task ? 'Edit Task' : 'New Task'}</h3>
            <div class="form-group">
                <label for="task-title">Title</label>
                <input type="text" id="task-title" required value="${task ? security.sanitizeInput(task.title) : ''}">
            </div>
            <div class="form-group">
                <label for="task-description">Description</label>
                <textarea id="task-description" rows="3">${task ? security.sanitizeInput(task.description) : ''}</textarea>
            </div>
            <div class="form-group">
                <label for="task-status">Status</label>
                <select id="task-status">
                    <option value="pending" ${task?.status === 'pending' ? 'selected' : ''}>Pending</option>
                    <option value="in-progress" ${task?.status === 'in-progress' ? 'selected' : ''}>In Progress</option>
                    <option value="completed" ${task?.status === 'completed' ? 'selected' : ''}>Completed</option>
                </select>
            </div>
            <div class="dialog-buttons">
                <button type="button" class="btn-secondary" onclick="this.closest('dialog').close()">Cancel</button>
                <button type="submit" class="btn-primary">${task ? 'Update' : 'Create'}</button>
            </div>
        </form>
    `;

    document.body.appendChild(dialog);
    dialog.showModal();

    dialog.querySelector('#task-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const taskData = {
            title: document.getElementById('task-title').value,
            description: document.getElementById('task-description').value,
            status: document.getElementById('task-status').value
        };

        if (task) {
            await TaskManager.updateTask(task.id, taskData);
        } else {
            await TaskManager.createTask(taskData);
        }

        dialog.close();
        dialog.remove();
        this.renderTaskList();
    });
};

UI.updateTaskList = function(tasks) {
    const taskList = document.querySelector('.task-list');
    taskList.innerHTML = tasks.map(task => UI.renderTaskCard(task)).join('');
};

UI.renderTaskCard = function(task) {
    return `
        <div class="task-card" data-id="${task.id}">
            <div class="task-header">
                <div class="task-title-section">
                    <h3>${security.sanitizeInput(task.title)}</h3>
                    ${task.priority ? `
                        <span class="task-priority" title="AI Priority Score">
                            <span class="material-icons">analytics</span>
                            ${task.priority.toFixed(1)}
                        </span>
                    ` : ''}
                </div>
                <div class="task-actions">
                    <button class="edit-task-btn" data-id="${task.id}">Edit</button>
                    <button class="delete-task-btn" data-id="${task.id}">Delete</button>
                </div>
            </div>
            <p>${security.sanitizeInput(task.description)}</p>
            ${task.aiSuggestions?.length ? `
                <div class="ai-suggestions">
                    <div class="suggestions-header">
                        <span class="material-icons">lightbulb</span>
                        AI Suggestions
                    </div>
                    <ul>
                        ${task.aiSuggestions.map(suggestion => 
                            `<li>${security.sanitizeInput(suggestion)}</li>`
                        ).join('')}
                    </ul>
                </div>
            ` : ''}
            <div class="task-footer">
                <span class="task-status ${task.status}">${task.status}</span>
                <span class="task-date">${new Date(task.createdAt).toLocaleDateString()}</span>
            </div>
        </div>
    `;
};

// Event handlers for task management
events.on('task:created', () => {
    UI.renderTaskList();
});

events.on('task:updated', () => {
    UI.renderTaskList();
});

events.on('task:deleted', () => {
    UI.renderTaskList();
});

// Notes Management System
const NotesManager = {
    async createNote(note) {
        note.id = utils.generateId();
        note.createdAt = new Date().toISOString();
        note.tags = note.tags || [];
        
        // Add AI analysis
        const analysis = await AIService.analyzeNote(note);
        note.summary = analysis.summary;
        note.topics = analysis.topics;
        note.aiAnalysis = analysis;
        
        await secureDb.setItem('notes', note.id, note);
        events.emit('note:created', note);
        return note;
    },

    async updateNote(noteId, updates) {
        const note = await secureDb.getItem('notes', noteId);
        if (!note) throw new Error('Note not found');

        const updatedNote = { ...note, ...updates, updatedAt: new Date().toISOString() };
        await secureDb.setItem('notes', noteId, updatedNote);
        events.emit('note:updated', updatedNote);
        return updatedNote;
    },

    async deleteNote(noteId) {
        await db.notes.removeItem(noteId);
        events.emit('note:deleted', noteId);
    },

    async getAllNotes() {
        const notes = [];
        await db.notes.iterate((value, key) => {
            notes.push(value);
        });
        return notes.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },

    async searchNotes(query) {
        const allNotes = await this.getAllNotes();
        const searchQuery = query.toLowerCase();
        return allNotes.filter(note => 
            note.title.toLowerCase().includes(searchQuery) ||
            note.content.toLowerCase().includes(searchQuery) ||
            note.tags.some(tag => tag.toLowerCase().includes(searchQuery))
        );
    },

    async summarizeContent(content) {
        // This would ideally use a proper AI API, but for now we'll use a simple summary
        const sentences = content.split(/[.!?]+/).filter(Boolean);
        return sentences.slice(0, 2).join('. ') + '.';
    }
};

// Enhance NotesManager with offline support
Object.assign(NotesManager, {
    async getAllNotes() {
        try {
            // Try to fetch from network first
            const response = await fetch('/api/notes');
            if (response.ok) {
                const notes = await response.json();
                // Update local storage
                await Promise.all(notes.map(note => 
                    DBManager.put('notes', note)
                ));
                return notes;
            }
        } catch (error) {
            console.log('Fetching from network failed, using local data');
        }

        // Fallback to local data
        return await DBManager.getAll('notes');
    },

    async getNote(id) {
        try {
            const response = await fetch(`/api/notes/${id}`);
            if (response.ok) {
                const note = await response.json();
                await DBManager.put('notes', note);
                return note;
            }
        } catch (error) {
            console.log('Fetching from network failed, using local data');
        }

        return await DBManager.get('notes', id);
    },

    async saveNote(note) {
        // Add to sync queue
        await DBManager.put('syncQueue', {
            id: utils.generateId(),
            type: 'note',
            action: note.id ? 'update' : 'create',
            data: note,
            timestamp: Date.now()
        });

        // Save locally
        if (!note.id) {
            note.id = utils.generateId();
        }
        note.updatedAt = new Date().toISOString();
        await DBManager.put('notes', note);

        // Try to sync immediately
        if (navigator.onLine) {
            await this.syncNotes();
        }

        return note;
    },

    async deleteNote(id) {
        // Add to sync queue
        await DBManager.put('syncQueue', {
            id: utils.generateId(),
            type: 'note',
            action: 'delete',
            data: { id },
            timestamp: Date.now()
        });

        // Delete locally
        await DBManager.delete('notes', id);

        // Try to sync immediately
        if (navigator.onLine) {
            await this.syncNotes();
        }
    },

    async syncNotes() {
        const queue = await DBManager.getAll('syncQueue');
        const noteQueue = queue.filter(item => item.type === 'note');

        for (const item of noteQueue) {
            try {
                let response;
                switch (item.action) {
                    case 'create':
                    case 'update':
                        response = await fetch('/api/notes', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(item.data)
                        });
                        break;
                    case 'delete':
                        response = await fetch(`/api/notes/${item.data.id}`, {
                            method: 'DELETE'
                        });
                        break;
                }

                if (response?.ok) {
                    await DBManager.delete('syncQueue', item.id);
                }
            } catch (error) {
                console.error('Sync failed for item:', item);
            }
        }
    }
});

// Notes UI Components
UI.renderNotesList = async function() {
    const notes = await NotesManager.getAllNotes();
    const contentArea = document.getElementById('content-area');
    
    contentArea.innerHTML = `
        <div class="notes-container">
            <div class="notes-header">
                <h2>Notes</h2>
                <div class="notes-actions">
                    <input type="text" id="note-search" placeholder="Search notes..." class="search-input">
                    <button id="new-note-btn" class="btn-primary">New Note</button>
                </div>
            </div>
            <div class="notes-grid">
                ${notes.map(note => UI.renderNoteCard(note)).join('')}
            </div>
        </div>
    `;

    // Event Listeners
    document.getElementById('new-note-btn').addEventListener('click', () => {
        this.showNoteForm();
    });

    document.getElementById('note-search').addEventListener('input', utils.debounce(async (e) => {
        const query = e.target.value;
        const filteredNotes = query ? await NotesManager.searchNotes(query) : await NotesManager.getAllNotes();
        this.updateNotesList(filteredNotes);
    }, 300));

    document.querySelectorAll('.edit-note-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const noteId = e.target.dataset.id;
            const note = await secureDb.getItem('notes', noteId);
            this.showNoteForm(note);
        });
    });

    document.querySelectorAll('.delete-note-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            if (confirm('Are you sure you want to delete this note?')) {
                const noteId = e.target.dataset.id;
                await NotesManager.deleteNote(noteId);
            }
        });
    });
};

UI.showNoteForm = function(note = null) {
    const dialog = document.createElement('dialog');
    dialog.className = 'note-dialog';
    
    dialog.innerHTML = `
        <form id="note-form">
            <h3>${note ? 'Edit Note' : 'New Note'}</h3>
            <div class="form-group">
                <label for="note-title">Title</label>
                <input type="text" id="note-title" required value="${note ? security.sanitizeInput(note.title) : ''}">
            </div>
            <div class="form-group">
                <label for="note-content">Content</label>
                <textarea id="note-content" rows="10" class="note-editor">${note ? security.sanitizeInput(note.content) : ''}</textarea>
            </div>
            <div class="form-group">
                <label for="note-tags">Tags (comma-separated)</label>
                <input type="text" id="note-tags" value="${note ? note.tags.join(', ') : ''}">
            </div>
            <div class="dialog-buttons">
                <button type="button" class="btn-secondary" onclick="this.closest('dialog').close()">Cancel</button>
                <button type="submit" class="btn-primary">${note ? 'Update' : 'Create'}</button>
            </div>
        </form>
    `;

    document.body.appendChild(dialog);
    dialog.showModal();

    // Initialize markdown editor (we'll implement this later)
    // initializeMarkdownEditor(document.querySelector('.note-editor'));

    dialog.querySelector('#note-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const noteData = {
            title: document.getElementById('note-title').value,
            content: document.getElementById('note-content').value,
            tags: document.getElementById('note-tags').value
                .split(',')
                .map(tag => tag.trim())
                .filter(Boolean)
        };

        if (note) {
            await NotesManager.updateNote(note.id, noteData);
        } else {
            await NotesManager.createNote(noteData);
        }

        dialog.close();
        dialog.remove();
        this.renderNotesList();
    });
};

UI.updateNotesList = function(notes) {
    const notesGrid = document.querySelector('.notes-grid');
    notesGrid.innerHTML = notes.map(note => UI.renderNoteCard(note)).join('');
};

UI.renderNoteCard = function(note) {
    return `
        <div class="note-card" data-id="${note.id}">
            <div class="note-header">
                <div class="note-title-section">
                    <h3>${security.sanitizeInput(note.title)}</h3>
                    ${note.topics?.length ? `
                        <div class="note-topics">
                            ${note.topics.map(topic => 
                                `<span class="topic-tag">${security.sanitizeInput(topic)}</span>`
                            ).join('')}
                        </div>
                    ` : ''}
                </div>
                <div class="note-actions">
                    <button class="edit-note-btn" data-id="${note.id}">Edit</button>
                    <button class="delete-note-btn" data-id="${note.id}">Delete</button>
                </div>
            </div>
            ${note.summary ? `
                <div class="note-summary">
                    <div class="summary-header">
                        <span class="material-icons">auto_awesome</span>
                        AI Summary
                    </div>
                    <p>${security.sanitizeInput(note.summary)}</p>
                </div>
            ` : ''}
            <div class="note-content">
                ${security.sanitizeInput(note.content)}
            </div>
            ${note.aiAnalysis?.relatedNotes?.length ? `
                <div class="related-notes">
                    <div class="related-header">
                        <span class="material-icons">layers</span>
                        Related Notes
                    </div>
                    <ul>
                        ${note.aiAnalysis.relatedNotes.map(related => 
                            `<li>
                                <a href="#" class="related-note-link" data-id="${related.id}">
                                    ${security.sanitizeInput(related.title)}
                                </a>
                            </li>`
                        ).join('')}
                    </ul>
                </div>
            ` : ''}
            <div class="note-footer">
                <div class="note-tags">
                    ${note.tags.map(tag => 
                        `<span class="tag">${security.sanitizeInput(tag)}</span>`
                    ).join('')}
                </div>
                <span class="note-date">${new Date(note.createdAt).toLocaleDateString()}</span>
            </div>
        </div>
    `;
};

// Event handlers for notes management
events.on('note:created', () => {
    UI.renderNotesList();
});

events.on('note:updated', () => {
    UI.renderNotesList();
});

events.on('note:deleted', () => {
    UI.renderNotesList();
});

// Study Room System
const StudyRoom = {
    peers: new Map(),
    localStream: null,
    roomCode: null,
    peer: null,
    connections: new Map(),

    async createRoom() {
        this.roomCode = utils.generateId().slice(0, 6).toUpperCase();
        await this.initializeMedia();
        await this.initializePeer();
        return this.roomCode;
    },

    async joinRoom(code) {
        this.roomCode = code.toUpperCase();
        await this.initializeMedia();
        await this.initializePeer();
        await this.connectToRoom();
    },

    async initializePeer() {
        if (this.peer) {
            this.peer.destroy();
        }

        return new Promise((resolve, reject) => {
            this.peer = new Peer(utils.generateId(), {
                debug: 2,
                config: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:global.stun.twilio.com:3478' }
                    ]
                }
            });

            this.peer.on('open', (id) => {
                console.log('My peer ID is: ' + id);
                this.setupPeerEvents();
                resolve();
            });

            this.peer.on('error', (error) => {
                errorHandler.report(error, { context: 'peer-initialization' });
                reject(error);
            });
        });
    },

    setupPeerEvents() {
        this.peer.on('call', async (call) => {
            try {
                call.answer(this.localStream);
                this.handleCall(call);
            } catch (error) {
                errorHandler.report(error, { context: 'peer-call-answer' });
            }
        });

        this.peer.on('connection', (conn) => {
            this.handleConnection(conn);
        });
    },

    async connectToRoom() {
        // Connect to all peers in the room
        const roomPeers = await this.getRoomPeers();
        for (const peerId of roomPeers) {
            this.connectToPeer(peerId);
        }
    },

    async getRoomPeers() {
        // In a real application, this would fetch the list of peers from a signaling server
        // For now, we'll use a simple demo approach
        return [];
    },

    connectToPeer(peerId) {
        // Establish media connection
        const call = this.peer.call(peerId, this.localStream);
        this.handleCall(call);

        // Establish data connection
        const conn = this.peer.connect(peerId);
        this.handleConnection(conn);
    },

    handleCall(call) {
        call.on('stream', (remoteStream) => {
            events.emit('peer:stream', { peerId: call.peer, stream: remoteStream });
        });

        call.on('close', () => {
            events.emit('peer:disconnect', call.peer);
        });

        this.peers.set(call.peer, call);
    },

    handleConnection(conn) {
        conn.on('open', () => {
            this.connections.set(conn.peer, conn);
            events.emit('peer:connect', conn.peer);
        });

        conn.on('data', (data) => {
            this.handlePeerMessage(conn.peer, data);
        });

        conn.on('close', () => {
            this.connections.delete(conn.peer);
            events.emit('peer:disconnect', conn.peer);
        });
    },

    handlePeerMessage(peerId, message) {
        switch (message.type) {
            case 'chat':
                events.emit('chat:message', {
                    sender: message.sender,
                    content: message.content,
                    timestamp: new Date()
                });
                break;
            // Add more message types as needed
        }
    },

    sendMessage(message) {
        const data = {
            type: 'chat',
            sender: AppState.user?.name || 'Anonymous',
            content: message
        };

        this.connections.forEach(conn => {
            conn.send(data);
        });

        // Add own message to chat
        events.emit('chat:message', {
            sender: data.sender,
            content: data.content,
            timestamp: new Date()
        });
    },

    async initializeMedia() {
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });
            events.emit('media:initialized', this.localStream);
        } catch (error) {
            errorHandler.report(error, { context: 'media-initialization' });
            throw new Error('Failed to access camera/microphone');
        }
    },

    async stopMedia() {
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }

        this.peers.forEach(peer => peer.close());
        this.peers.clear();
        this.connections.clear();

        if (this.peer) {
            this.peer.destroy();
            this.peer = null;
        }
    }
};

// Study Room UI Components
UI.renderStudyRoom = function() {
    const contentArea = document.getElementById('content-area');
    
    contentArea.innerHTML = `
        <div class="study-room-container">
            <div class="study-room-header">
                <h2>Study Room</h2>
                <div class="room-actions">
                    <div class="room-code-section ${StudyRoom.roomCode ? '' : 'hidden'}">
                        <span>Room Code: <strong>${StudyRoom.roomCode || ''}</strong></span>
                        <button id="copy-code-btn" class="btn-secondary">Copy Code</button>
                    </div>
                    <button id="create-room-btn" class="btn-primary ${StudyRoom.roomCode ? 'hidden' : ''}">Create Room</button>
                    <button id="join-room-btn" class="btn-primary ${StudyRoom.roomCode ? 'hidden' : ''}">Join Room</button>
                    <button id="leave-room-btn" class="btn-secondary ${StudyRoom.roomCode ? '' : 'hidden'}">Leave Room</button>
                </div>
            </div>
            <div class="study-room-content">
                <div class="video-grid" id="video-grid"></div>
                <div class="study-controls">
                    <button id="toggle-video" class="control-btn">
                        <span class="material-icons">videocam</span>
                    </button>
                    <button id="toggle-audio" class="control-btn">
                        <span class="material-icons">mic</span>
                    </button>
                    <button id="share-screen" class="control-btn">
                        <span class="material-icons">screen_share</span>
                    </button>
                </div>
                <div class="chat-section">
                    <div class="chat-messages" id="chat-messages"></div>
                    <div class="chat-input-section">
                        <input type="text" id="chat-input" placeholder="Type a message...">
                        <button id="send-message" class="btn-primary">Send</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    this.initializeStudyRoomEvents();

    // Add event listeners for peer events
    events.on('peer:stream', ({ peerId, stream }) => {
        this.addVideoStream(peerId, stream);
    });

    events.on('peer:disconnect', (peerId) => {
        this.removeVideoStream(peerId);
    });

    events.on('chat:message', (message) => {
        this.addChatMessage(message);
    });
};

UI.addVideoStream = function(peerId, stream) {
    const videoGrid = document.getElementById('video-grid');
    const videoContainer = document.createElement('div');
    videoContainer.className = 'video-container';
    videoContainer.dataset.peerId = peerId;

    const video = document.createElement('video');
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    if (stream === StudyRoom.localStream) {
        video.muted = true;
    }

    const participantName = document.createElement('div');
    participantName.className = 'participant-name';
    participantName.textContent = peerId === StudyRoom.peer?.id ? 
        (AppState.user?.name || 'You') : 
        'Participant';

    videoContainer.appendChild(video);
    videoContainer.appendChild(participantName);
    videoGrid.appendChild(videoContainer);
};

UI.removeVideoStream = function(peerId) {
    const videoContainer = document.querySelector(`.video-container[data-peer-id="${peerId}"]`);
    if (videoContainer) {
        videoContainer.remove();
    }
};

UI.initializeStudyRoomEvents = function() {
    const createRoomBtn = document.getElementById('create-room-btn');
    const joinRoomBtn = document.getElementById('join-room-btn');
    const leaveRoomBtn = document.getElementById('leave-room-btn');
    const copyCodeBtn = document.getElementById('copy-code-btn');
    const toggleVideoBtn = document.getElementById('toggle-video');
    const toggleAudioBtn = document.getElementById('toggle-audio');
    const shareScreenBtn = document.getElementById('share-screen');
    const chatInput = document.getElementById('chat-input');
    const sendMessageBtn = document.getElementById('send-message');

    createRoomBtn?.addEventListener('click', async () => {
        try {
            const roomCode = await StudyRoom.createRoom();
            this.renderStudyRoom();
            this.showNotification('Room created! Share the code with others.');
        } catch (error) {
            this.showError('Failed to create room');
        }
    });

    joinRoomBtn?.addEventListener('click', () => {
        this.showRoomJoinDialog();
    });

    leaveRoomBtn?.addEventListener('click', async () => {
        if (confirm('Are you sure you want to leave the room?')) {
            await StudyRoom.stopMedia();
            StudyRoom.roomCode = null;
            this.renderStudyRoom();
        }
    });

    copyCodeBtn?.addEventListener('click', () => {
        if (StudyRoom.roomCode) {
            navigator.clipboard.writeText(StudyRoom.roomCode);
            this.showNotification('Room code copied to clipboard!');
        }
    });

    toggleVideoBtn?.addEventListener('click', () => {
        const videoTrack = StudyRoom.localStream?.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            toggleVideoBtn.classList.toggle('disabled');
        }
    });

    toggleAudioBtn?.addEventListener('click', () => {
        const audioTrack = StudyRoom.localStream?.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            toggleAudioBtn.classList.toggle('disabled');
        }
    });

    shareScreenBtn?.addEventListener('click', async () => {
        try {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: true
            });
            // Replace video track with screen share
            const videoTrack = StudyRoom.localStream.getVideoTracks()[0];
            if (videoTrack) {
                StudyRoom.localStream.removeTrack(videoTrack);
                StudyRoom.localStream.addTrack(screenStream.getVideoTracks()[0]);
                events.emit('track:changed', StudyRoom.localStream);
            }
        } catch (error) {
            this.showError('Failed to share screen');
        }
    });

    sendMessageBtn?.addEventListener('click', () => {
        const message = chatInput.value.trim();
        if (message) {
            StudyRoom.sendMessage(message);
            chatInput.value = '';
        }
    });

    chatInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessageBtn.click();
        }
    });

    // Add local video stream when media is initialized
    events.on('media:initialized', (stream) => {
        this.addVideoStream(StudyRoom.peer?.id, stream);
    });
};

UI.showRoomJoinDialog = function() {
    const dialog = document.createElement('dialog');
    dialog.className = 'room-dialog';
    
    dialog.innerHTML = `
        <form id="room-join-form">
            <h3>Join Study Room</h3>
            <div class="form-group">
                <label for="room-code">Room Code</label>
                <input type="text" id="room-code" required pattern="[A-Za-z0-9]{6}" 
                    maxlength="6" placeholder="Enter 6-digit room code">
            </div>
            <div class="dialog-buttons">
                <button type="button" class="btn-secondary" onclick="this.closest('dialog').close()">Cancel</button>
                <button type="submit" class="btn-primary">Join</button>
            </div>
        </form>
    `;

    document.body.appendChild(dialog);
    dialog.showModal();

    dialog.querySelector('#room-join-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const code = document.getElementById('room-code').value;
        try {
            await StudyRoom.joinRoom(code);
            dialog.close();
            this.renderStudyRoom();
        } catch (error) {
            this.showError('Failed to join room');
        }
    });
};

UI.addChatMessage = function(message) {
    const chatMessages = document.getElementById('chat-messages');
    const messageElement = document.createElement('div');
    messageElement.className = `chat-message ${message.sender === (AppState.user?.name || 'You') ? 'own-message' : ''}`;
    
    messageElement.innerHTML = `
        <div class="message-header">
            <span class="message-sender">${security.sanitizeInput(message.sender)}</span>
            <span class="message-time">${new Date(message.timestamp).toLocaleTimeString()}</span>
        </div>
        <div class="message-content">${security.sanitizeInput(message.content)}</div>
    `;

    chatMessages.appendChild(messageElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
};

UI.showNotification = function(message) {
    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.remove();
    }, 3000);
};

UI.showError = function(message) {
    const error = document.createElement('div');
    error.className = 'notification error';
    error.textContent = message;
    document.body.appendChild(error);
    
    setTimeout(() => {
        error.remove();
    }, 3000);
};

// Router System
const Router = {
    currentRoute: null,

    routes: {
        '#dashboard': () => UI.renderWelcomeContent(),
        '#tasks': () => UI.renderTaskList(),
        '#notes': () => UI.renderNotesList(),
        '#study': () => UI.renderStudyRoom(),
        '#settings': () => UI.renderSettings(),
        '#files': () => UI.renderFileManager()
    },

    init() {
        window.addEventListener('hashchange', () => this.handleRoute());
        window.addEventListener('load', () => this.handleRoute());
    },

    handleRoute() {
        const hash = window.location.hash || '#dashboard';
        this.currentRoute = hash;
        
        // Update active state in navigation
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.toggle('active', link.getAttribute('href') === hash);
        });
        
        document.querySelectorAll('.sidebar-link').forEach(link => {
            link.classList.toggle('active', link.getAttribute('href') === hash);
        });

        // Call the route handler
        const routeHandler = this.routes[hash];
        if (routeHandler) {
            routeHandler();
        } else {
            this.routes['#dashboard']();
        }
    }
};

// Settings UI Component
UI.renderSettings = function() {
    const contentArea = document.getElementById('content-area');
    
    contentArea.innerHTML = `
        <div class="settings-container">
            <h2>Settings</h2>
            <div class="settings-group">
                <h3>Appearance</h3>
                <div class="setting-item">
                    <label for="theme-select">Theme</label>
                    <select id="theme-select">
                        <option value="system">System Default</option>
                        <option value="light">Light</option>
                        <option value="dark">Dark</option>
                    </select>
                </div>
                <div class="setting-item">
                    <label for="font-size">Font Size</label>
                    <select id="font-size">
                        <option value="small">Small</option>
                        <option value="medium" selected>Medium</option>
                        <option value="large">Large</option>
                    </select>
                </div>
            </div>
            <div class="settings-group">
                <h3>Notifications</h3>
                <div class="setting-item">
                    <label class="toggle-label">
                        <input type="checkbox" id="notify-tasks">
                        Task Reminders
                    </label>
                </div>
                <div class="setting-item">
                    <label class="toggle-label">
                        <input type="checkbox" id="notify-messages">
                        Study Room Messages
                    </label>
                </div>
            </div>
            <div class="settings-group">
                <h3>Data & Privacy</h3>
                <div class="setting-item">
                    <button id="export-data" class="btn-secondary">Export My Data</button>
                    <button id="clear-data" class="btn-secondary danger">Clear All Data</button>
                </div>
            </div>
        </div>
    `;

    this.initializeSettingsEvents();
};

UI.initializeSettingsEvents = function() {
    const themeSelect = document.getElementById('theme-select');
    const fontSizeSelect = document.getElementById('font-size');
    const notifyTasks = document.getElementById('notify-tasks');
    const notifyMessages = document.getElementById('notify-messages');
    const exportData = document.getElementById('export-data');
    const clearData = document.getElementById('clear-data');

    // Load saved settings
    const settings = AppState.settings || {};
    themeSelect.value = settings.theme || 'system';
    fontSizeSelect.value = settings.fontSize || 'medium';
    notifyTasks.checked = settings.notifyTasks !== false;
    notifyMessages.checked = settings.notifyMessages !== false;

    // Theme change handler
    themeSelect.addEventListener('change', async (e) => {
        const theme = e.target.value;
        document.documentElement.setAttribute('data-theme', theme);
        await this.updateSettings({ theme });
    });

    // Font size change handler
    fontSizeSelect.addEventListener('change', async (e) => {
        const fontSize = e.target.value;
        document.documentElement.style.fontSize = {
            small: '14px',
            medium: '16px',
            large: '18px'
        }[fontSize];
        await this.updateSettings({ fontSize });
    });

    // Notification settings
    notifyTasks.addEventListener('change', async (e) => {
        await this.updateSettings({ notifyTasks: e.target.checked });
    });

    notifyMessages.addEventListener('change', async (e) => {
        await this.updateSettings({ notifyMessages: e.target.checked });
    });

    // Data management
    exportData.addEventListener('click', async () => {
        try {
            const data = {
                tasks: await TaskManager.getAllTasks(),
                notes: await NotesManager.getAllNotes(),
                settings: AppState.settings
            };
            
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `produlearn-backup-${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
            
            this.showNotification('Data exported successfully!');
        } catch (error) {
            this.showError('Failed to export data');
            errorHandler.report(error, { context: 'data-export' });
        }
    });

    clearData.addEventListener('click', async () => {
        if (confirm('Are you sure you want to clear all data? This action cannot be undone.')) {
            try {
                await Promise.all([
                    db.tasks.clear(),
                    db.notes.clear(),
                    db.settings.clear()
                ]);
                
                AppState.settings = null;
                events.emit('settings:changed', null);
                window.location.reload();
            } catch (error) {
                this.showError('Failed to clear data');
                errorHandler.report(error, { context: 'data-clear' });
            }
        }
    });
};

UI.updateSettings = async function(updates) {
    try {
        const settings = { ...AppState.settings, ...updates };
        await secureDb.setItem('settings', 'user-settings', settings);
        AppState.settings = settings;
        events.emit('settings:changed', settings);
        this.showNotification('Settings saved successfully!');
    } catch (error) {
        this.showError('Failed to save settings');
        errorHandler.report(error, { context: 'settings-update' });
    }
};

// File Management System
const FileManager = {
    async uploadFile(file) {
        const fileId = utils.generateId();
        const fileData = {
            id: fileId,
            name: file.name,
            type: file.type,
            size: file.size,
            lastModified: file.lastModified,
            uploadedAt: new Date().toISOString()
        };

        // Convert file to ArrayBuffer for storage
        const buffer = await file.arrayBuffer();
        const encryptedData = await security.encrypt({
            metadata: fileData,
            content: Array.from(new Uint8Array(buffer))
        });

        await db.files.setItem(fileId, encryptedData);
        events.emit('file:uploaded', fileData);
        return fileData;
    },

    async downloadFile(fileId) {
        const encryptedData = await db.files.getItem(fileId);
        if (!encryptedData) throw new Error('File not found');

        const decryptedData = await security.decrypt(encryptedData);
        const { metadata, content } = decryptedData;

        const blob = new Blob([new Uint8Array(content)], { type: metadata.type });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = metadata.name;
        a.click();
        
        URL.revokeObjectURL(url);
    },

    async deleteFile(fileId) {
        await db.files.removeItem(fileId);
        events.emit('file:deleted', fileId);
    },

    async getAllFiles() {
        const files = [];
        await db.files.iterate(async (encryptedData, key) => {
            const decryptedData = await security.decrypt(encryptedData);
            files.push(decryptedData.metadata);
        });
        return files.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    }
};

// File Management UI Components
UI.renderFileManager = async function() {
    const files = await FileManager.getAllFiles();
    const contentArea = document.getElementById('content-area');
    
    contentArea.innerHTML = `
        <div class="files-container">
            <div class="files-header">
                <h2>Files</h2>
                <div class="file-actions">
                    <label for="file-upload" class="btn-primary">
                        Upload File
                        <input type="file" id="file-upload" multiple style="display: none;">
                    </label>
                </div>
            </div>
            <div class="files-grid">
                ${files.map(file => `
                    <div class="file-card" data-id="${file.id}">
                        <div class="file-icon">
                            <span class="material-icons">${this.getFileIcon(file.type)}</span>
                        </div>
                        <div class="file-info">
                            <h3>${security.sanitizeInput(file.name)}</h3>
                            <span class="file-meta">
                                ${this.formatFileSize(file.size)} • 
                                ${new Date(file.uploadedAt).toLocaleDateString()}
                            </span>
                        </div>
                        <div class="file-actions">
                            <button class="download-file-btn" data-id="${file.id}">
                                <span class="material-icons">download</span>
                            </button>
                            <button class="delete-file-btn" data-id="${file.id}">
                                <span class="material-icons">delete</span>
                            </button>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;

    // Event Listeners
    document.getElementById('file-upload').addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        for (const file of files) {
            try {
                await FileManager.uploadFile(file);
                this.showNotification(`Uploaded: ${file.name}`);
            } catch (error) {
                this.showError(`Failed to upload: ${file.name}`);
            }
        }
        e.target.value = '';
    });

    document.querySelectorAll('.download-file-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const fileId = e.target.closest('button').dataset.id;
            try {
                await FileManager.downloadFile(fileId);
            } catch (error) {
                this.showError('Failed to download file');
            }
        });
    });

    document.querySelectorAll('.delete-file-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const fileId = e.target.closest('button').dataset.id;
            if (confirm('Are you sure you want to delete this file?')) {
                try {
                    await FileManager.deleteFile(fileId);
                    this.showNotification('File deleted successfully');
                } catch (error) {
                    this.showError('Failed to delete file');
                }
            }
        });
    });
};

UI.getFileIcon = function(mimeType) {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'movie';
    if (mimeType.startsWith('audio/')) return 'audio_file';
    if (mimeType.includes('pdf')) return 'picture_as_pdf';
    if (mimeType.includes('word')) return 'description';
    if (mimeType.includes('sheet')) return 'table_chart';
    if (mimeType.includes('presentation')) return 'slideshow';
    return 'insert_drive_file';
};

UI.formatFileSize = function(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    
    return `${size.toFixed(1)} ${units[unitIndex]}`;
};

// Add file management route
Router.routes['#files'] = () => UI.renderFileManager();

// Event handlers for file management
events.on('file:uploaded', () => {
    if (Router.currentRoute === '#files') {
        UI.renderFileManager();
    }
});

events.on('file:deleted', () => {
    if (Router.currentRoute === '#files') {
        UI.renderFileManager();
    }
});

// AI Service for intelligent features
const AIService = {
    async analyzeNote(noteText) {
        // Simulate AI analysis with some basic NLP-like functionality
        const words = noteText.toLowerCase().split(/\s+/);
        const topics = new Set();
        const actionItems = [];
        
        // Simple keyword-based analysis
        const topicKeywords = ['project', 'meeting', 'idea', 'plan', 'research'];
        const actionKeywords = ['todo', 'need to', 'should', 'must', 'implement'];
        
        words.forEach((word, index) => {
            if (topicKeywords.includes(word)) {
                topics.add(word);
            }
            if (actionKeywords.some(keyword => word.includes(keyword))) {
                const phrase = words.slice(index, index + 5).join(' ');
                actionItems.push(phrase);
            }
        });

        return {
            summary: noteText.length > 100 ? noteText.substring(0, 100) + '...' : noteText,
            topics: Array.from(topics),
            suggestedTasks: actionItems,
            sentiment: this._analyzeSentiment(noteText)
        };
    },

    async prioritizeTasks(tasks) {
        // Simple priority scoring based on keywords and due dates
        return tasks.map(task => {
            let priorityScore = 0;
            
            // Priority keywords
            const urgentKeywords = ['urgent', 'asap', 'important', 'critical'];
            if (urgentKeywords.some(keyword => 
                task.title.toLowerCase().includes(keyword) || 
                task.description.toLowerCase().includes(keyword))) {
                priorityScore += 2;
            }

            // Due date proximity
            if (task.dueDate) {
                const daysUntilDue = Math.ceil(
                    (new Date(task.dueDate) - new Date()) / (1000 * 60 * 60 * 24)
                );
                if (daysUntilDue <= 1) priorityScore += 3;
                else if (daysUntilDue <= 3) priorityScore += 2;
                else if (daysUntilDue <= 7) priorityScore += 1;
            }

            return {
                ...task,
                priorityScore,
                suggestedPriority: priorityScore >= 3 ? 'High' : 
                                priorityScore >= 1 ? 'Medium' : 'Low'
            };
        });
    },

    _analyzeSentiment(text) {
        const positiveWords = ['good', 'great', 'excellent', 'amazing', 'successful'];
        const negativeWords = ['bad', 'poor', 'issue', 'problem', 'fail'];
        
        const words = text.toLowerCase().split(/\s+/);
        let score = 0;
        
        words.forEach(word => {
            if (positiveWords.includes(word)) score++;
            if (negativeWords.includes(word)) score--;
        });

        return score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
    }
};

// Initialize application
async function initializeApp() {
    try {
        // Initialize core services
        await DBManager.init();
        await auth.init();
        network.init();
        errorHandler.init();
        
        // Set initial app state
        AppState.dbReady = true;
        
        // Initialize UI
        UI.init();
        
        // Emit app ready event
        events.emit('app:ready');
    } catch (error) {
        errorHandler.report(error, { context: 'app:initialization' });
    }
}

// Start the application when the page loads
window.addEventListener('load', initializeApp);

// Initialize application
async function initApp() {
    try {
        // Initialize error handling
        errorHandler.init();

        // Initialize network monitoring
        network.init();

        // Initialize authentication
        await auth.init();

        // Load saved user session
        const savedUser = await db.settings.getItem('user');
        if (savedUser) {
            AppState.user = savedUser;
            events.emit('auth:changed', savedUser);
        }

        // Load user settings
        const savedSettings = await db.settings.getItem('settings');
        if (savedSettings) {
            AppState.settings = savedSettings;
            events.emit('settings:changed', savedSettings);
        }

        // Initialize router
        Router.init();

        AppState.dbReady = true;
        events.emit('app:ready');
    } catch (error) {
        errorHandler.report(error, { context: 'app:init' });
    }
}

// Start the application
document.addEventListener('DOMContentLoaded', initApp);

// Initialize database and register service worker
async function initializeApp() {
    try {
        await DBManager.init();
        
        // Register service worker
        if ('serviceWorker' in navigator) {
            const registration = await navigator.serviceWorker.register('/sw.js');
            console.log('Service Worker registered with scope:', registration.scope);

            // Request notification permission
            if ('Notification' in window) {
                const permission = await Notification.requestPermission();
                console.log('Notification permission:', permission);
            }
        }

        // Set up online/offline handlers
        window.addEventListener('online', () => {
            document.body.classList.remove('offline');
            NotesManager.syncNotes();
            TaskManager.syncTasks();
        });

        window.addEventListener('offline', () => {
            document.body.classList.add('offline');
        });

        // Initial sync attempt
        if (navigator.onLine) {
            await Promise.all([
                NotesManager.syncNotes(),
                TaskManager.syncTasks()
            ]);
        }
    } catch (error) {
        console.error('Failed to initialize app:', error);
    }
}

// Initialize the app
initializeApp();

const DatabaseService = {
    async initDB() {
        this.db = await localforage.createInstance({
            name: 'productivityApp'
        });
    },

    async saveNote(note) {
        const notes = await this.getNotes();
        notes.push({
            ...note,
            id: Date.now(),
            timestamp: Date.now()
        });
        await this.db.setItem('notes', notes);
        return note;
    },

    async getNotes() {
        const notes = await this.db.getItem('notes');
        return notes || [];
    },

    async saveTask(task) {
        const tasks = await this.getTasks();
        tasks.push({
            ...task,
            id: Date.now(),
            timestamp: Date.now()
        });
        await this.db.setItem('tasks', tasks);
        return task;
    },

    async getTasks() {
        const tasks = await this.db.getItem('tasks');
        return tasks || [];
    },

    async updateTask(taskId, updates) {
        const tasks = await this.getTasks();
        const index = tasks.findIndex(t => t.id === taskId);
        if (index !== -1) {
            tasks[index] = { ...tasks[index], ...updates };
            await this.db.setItem('tasks', tasks);
            return tasks[index];
        }
        return null;
    },

    async deleteNote(noteId) {
        const notes = await this.getNotes();
        const filtered = notes.filter(note => note.id !== noteId);
        await this.db.setItem('notes', filtered);
    },

    async deleteTask(taskId) {
        const tasks = await this.getTasks();
        const filtered = tasks.filter(task => task.id !== taskId);
        await this.db.setItem('tasks', filtered);
    },

    async saveAIAnalysis(type, id, analysis) {
        const analyses = await this.db.getItem('aiAnalyses') || {};
        analyses[`${type}_${id}`] = analysis;
        await this.db.setItem('aiAnalyses', analyses);
    },

    async getAIAnalysis(type, id) {
        const analyses = await this.db.getItem('aiAnalyses') || {};
        return analyses[`${type}_${id}`];
    }
};

// Initialize database when the script loads
DatabaseService.initDB();

// App initialization
const App = {
    async init() {
        try {
            // Initialize database
            await DBManager.init();
            AppState.dbReady = true;

            // Set up UI components
            this.setupUI();
            
            // Set up event listeners
            this.setupEventListeners();
            
            // Initial render
            this.render();
            
            document.body.classList.add('app-ready');
        } catch (error) {
            console.error('App initialization failed:', error);
            this.showError('Failed to initialize application');
        }
    },

    setupUI() {
        // Initialize navigation
        const navLinks = document.getElementById('nav-links');
        navLinks.innerHTML = `
            <a href="#dashboard" class="nav-link">Dashboard</a>
            <a href="#tasks" class="nav-link">Tasks</a>
            <a href="#notes" class="nav-link">Notes</a>
            <a href="#study" class="nav-link">Study Room</a>
        `;

        // Initialize user section
        const userSection = document.getElementById('user-section');
        userSection.innerHTML = `
            <button class="btn-primary">Sign In</button>
        `;
    },

    setupEventListeners() {
        // Handle navigation
        window.addEventListener('hashchange', () => this.render());
        
        // Handle online/offline status
        window.addEventListener('online', () => {
            AppState.isOnline = true;
            this.updateStatusBar();
        });
        window.addEventListener('offline', () => {
            AppState.isOnline = false;
            this.updateStatusBar();
        });
    },

    async render() {
        const contentArea = document.getElementById('content-area');
        const route = window.location.hash.slice(1) || 'dashboard';
        
        // Clear existing content
        contentArea.innerHTML = '';
        
        // Render appropriate content based on route
        switch (route) {
            case 'dashboard':
                contentArea.innerHTML = `
                    <h1>Welcome to ProduLearn Hub</h1>
                    <div class="feature-grid">
                        <div class="feature-card">
                            <h3>Tasks</h3>
                            <p>Organize your work efficiently</p>
                        </div>
                        <div class="feature-card">
                            <h3>Notes</h3>
                            <p>Capture and organize your thoughts</p>
                        </div>
                        <div class="feature-card">
                            <h3>Study Room</h3>
                            <p>Collaborate with peers in real-time</p>
                        </div>
                    </div>
                `;
                break;
            case 'tasks':
                const tasks = await DBService.getTasks();
                // Render tasks view
                break;
            case 'notes':
                const notes = await DBService.getNotes();
                // Render notes view
                break;
            case 'study':
                // Render study room view
                break;
        }
    },

    updateStatusBar() {
        const statusBar = document.getElementById('status-bar');
        statusBar.innerHTML = `
            <div class="status-indicators">
                <span class="connection-status ${AppState.isOnline ? 'online' : 'offline'}">
                    ${AppState.isOnline ? 'Online' : 'Offline'}
                </span>
            </div>
        `;
    },

    showError(message) {
        const notification = document.createElement('div');
        notification.className = 'notification error';
        notification.textContent = message;
        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), 5000);
    }
};

// Initialize the application when DOM is ready
document.addEventListener('DOMContentLoaded', () => App.init());

// Initialize the application when the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    // Initialize core systems
    network.init();
    errorHandler.init();
    auth.init().catch(error => {
        console.error('Auth initialization failed:', error);
    });

    // Initialize the UI
    UI.init();
    
    // Emit app ready event
    events.emit('app:ready');
});
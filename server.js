const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Grok (xAI) setup
let grok;
try {
    if (!process.env.GROK_API_KEY) {
        console.error('❌ GROK_API_KEY not set in environment!');
    }
    grok = new OpenAI({
        apiKey: process.env.GROK_API_KEY || 'missing-key',
        baseURL: 'https://api.x.ai/v1'
    });
} catch(e) {
    console.error('Failed to initialize Grok client:', e.message);
}

// Model configurations
const MODELS = {
    normal: { model: 'grok-4.3', maxTokens: 2048, temperature: 0.7 },
    smart: { model: 'grok-4.3', maxTokens: 4096, temperature: 0.3 },
    expert: { model: 'grok-4.20-multi-agent', maxTokens: 4096, temperature: 0.5 }
};

// ==================== MAIN CHAT ENDPOINT ====================
app.post('/api/chat', async (req, res) => {
    try {
        const { messages, customInstructions, mode, agents, image } = req.body;
        
        // Validate API key
        if (!process.env.GROK_API_KEY) {
            return res.status(500).json({ 
                reply: '⚠️ Grok API key not configured. Please add it in Render environment variables.',
                model: 'Error'
            });
        }
        
        // Build conversation messages
        const conversationMessages = [];
        
        // Add custom instructions as system message
        if (customInstructions && customInstructions.trim()) {
            conversationMessages.push({
                role: 'system',
                content: customInstructions.trim()
            });
        }
        
        // Add conversation history
        if (messages && Array.isArray(messages)) {
            messages.forEach(msg => {
                if (!msg || !msg.role) return;
                
                if (msg.role === 'user') {
                    const content = [];
                    
                    if (msg.content && msg.content.trim()) {
                        content.push({ type: 'text', text: msg.content.trim() });
                    }
                    
                    if (msg.image && !msg.imageTooBig) {
                        content.push({
                            type: 'image_url',
                            image_url: { url: msg.image, detail: 'auto' }
                        });
                    }
                    
                    if (content.length > 0) {
                        conversationMessages.push({
                            role: 'user',
                            content: content.length === 1 && content[0].type === 'text' 
                                ? content[0].text 
                                : content
                        });
                    }
                } else if (msg.role === 'ai' || msg.role === 'assistant') {
                    if (msg.content && msg.content.trim()) {
                        conversationMessages.push({
                            role: 'assistant',
                            content: msg.content.trim()
                        });
                    }
                }
            });
        }
        
        // Add current image if not in history
        if (image && !messages?.some(m => m.image === image)) {
            const lastMsg = conversationMessages[conversationMessages.length - 1];
            if (lastMsg && lastMsg.role === 'user') {
                if (typeof lastMsg.content === 'string') {
                    lastMsg.content = [
                        { type: 'text', text: lastMsg.content },
                        { type: 'image_url', image_url: { url: image, detail: 'auto' } }
                    ];
                } else if (Array.isArray(lastMsg.content)) {
                    lastMsg.content.push({ type: 'image_url', image_url: { url: image, detail: 'auto' } });
                }
            } else {
                conversationMessages.push({
                    role: 'user',
                    content: [{ type: 'image_url', image_url: { url: image, detail: 'auto' } }]
                });
            }
        }
        
        // Ensure at least one message
        if (conversationMessages.length === 0) {
            conversationMessages.push({ role: 'user', content: 'Hello' });
        }
        
        // Remove duplicate system messages
        const systemMessages = conversationMessages.filter(m => m.role === 'system');
        if (systemMessages.length > 1) {
            const firstSystem = conversationMessages.findIndex(m => m.role === 'system');
            for (let i = conversationMessages.length - 1; i >= 0; i--) {
                if (conversationMessages[i].role === 'system' && i !== firstSystem) {
                    conversationMessages.splice(i, 1);
                }
            }
        }
        
        // Select model configuration
        const safeMode = mode || 'normal';
        const config = MODELS[safeMode] || MODELS.normal;
        
        console.log(`🤖 Mode: ${safeMode} | Model: ${config.model}`);
        
        let completion;
        
        if (safeMode === 'expert') {
            // ==================== EXPERT MODE ====================
            console.log(`🌐 Expert mode with ${agents || 4} agents`);
            
            completion = await grok.chat.completions.create({
                model: config.model,
                messages: conversationMessages,
                tools: [
                    { type: 'function', function: { name: 'web_search', description: 'Search the web for current information and recent data' } },
                    { type: 'function', function: { name: 'x_search', description: 'Search X (Twitter) for posts, trends, and discussions' } }
                ],
                tool_choice: 'auto',
                max_tokens: config.maxTokens,
                temperature: config.temperature,
            });
            
        } else if (safeMode === 'smart') {
            // ==================== SMART MODE ====================
            completion = await grok.chat.completions.create({
                model: config.model,
                messages: conversationMessages,
                max_tokens: config.maxTokens,
                temperature: config.temperature,
                reasoning_effort: 'high',
            });
            
        } else {
            // ==================== NORMAL MODE ====================
            completion = await grok.chat.completions.create({
                model: config.model,
                messages: conversationMessages,
                max_tokens: config.maxTokens,
                temperature: config.temperature,
            });
        }
        
        const reply = completion?.choices?.[0]?.message?.content || 'No response generated.';
        
        console.log(`✅ Response: ${reply.length} chars`);
        
        res.json({ 
            reply, 
            model: safeMode 
        });
        
    } catch (error) {
        console.error('❌ Grok API Error:', error.message, error.status);
        
        let errorMessage = 'An error occurred. Please try again.';
        let statusCode = 500;
        
        if (error.status === 401) {
            errorMessage = '🔑 Invalid API key. Check your Grok API key in Render environment.';
        } else if (error.status === 429) {
            errorMessage = '⏳ Rate limited. Wait a moment or add credits at console.x.ai.';
        } else if (error.status === 402) {
            errorMessage = '💰 Out of credits. Add funds at console.x.ai.';
        } else if (error.status === 422) {
            errorMessage = '⚠️ Invalid request format. Please try again.';
        } else if (error.status === 503) {
            errorMessage = '🔧 Grok service temporarily unavailable. Try again soon.';
        } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
            errorMessage = '🔌 Cannot connect to Grok servers. Check your internet.';
        } else if (error.message?.includes('timeout')) {
            errorMessage = '⏰ Request timed out. Expert mode may take longer.';
        } else if (error.message) {
            errorMessage = '⚠️ ' + error.message.substring(0, 100);
        }
        
        res.status(statusCode).json({ 
            reply: errorMessage,
            model: 'Error'
        });
    }
});

// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        app: 'GoldenSpaceAI2',
        version: '2.0.0',
        provider: 'Grok (xAI)',
        models: {
            normal: 'grok-4.3',
            smart: 'grok-4.3 (reasoning)',
            expert: 'grok-4.20-multi-agent (4-16 agents)'
        },
        tools: ['web_search (function)', 'x_search (function)'],
        apiKeyConfigured: !!process.env.GROK_API_KEY,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// ==================== CATCH-ALL ROUTE ====================
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'API endpoint not found' });
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== ERROR HANDLING ====================
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err.message);
    res.status(500).json({ 
        reply: '⚠️ Internal server error. Please try again.',
        model: 'Error'
    });
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
    console.log('═══════════════════════════════════════');
    console.log('🚀 GoldenSpaceAI2 Server');
    console.log('═══════════════════════════════════════');
    console.log(`📡 Port: ${PORT}`);
    console.log(`🤖 Provider: Grok (xAI)`);
    console.log(`⚡ Normal: grok-4.3`);
    console.log(`🧠 Smart: grok-4.3 (reasoning)`);
    console.log(`🌐 Expert: grok-4.20-multi-agent`);
    console.log(`🔧 Tools: web_search (function), x_search (function)`);
    console.log(`🔑 API Key: ${process.env.GROK_API_KEY ? '✅ Configured' : '❌ MISSING - Add GROK_API_KEY in Render'}`);
    console.log('═══════════════════════════════════════');
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('UNHANDLED REJECTION:', reason?.message || reason);
});

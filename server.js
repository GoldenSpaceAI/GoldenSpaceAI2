const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const path = require('path');
const https = require('https');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let grok;
try {
    grok = new OpenAI({
        apiKey: process.env.GROK_API_KEY || 'missing-key',
        baseURL: 'https://api.x.ai/v1'
    });
} catch(e) {
    console.error('Failed to initialize Grok client:', e.message);
}

const MODELS = {
    normal: { model: 'grok-4.3', maxTokens: 2048, temperature: 0.7 },
    smart: { model: 'grok-4.3', maxTokens: 4096, temperature: 0.3 },
    expert: { model: 'grok-4.20-multi-agent', maxTokens: 4096, temperature: 0.5 }
};

// ==================== MATH CLEANER ====================
function cleanLatex(text) {
    if (!text) return text;
    return text
        .replace(/\\boxed\{([^}]+)\}/g, '$1')
        .replace(/\\alpha\b/g, 'α').replace(/\\beta\b/g, 'β').replace(/\\gamma\b/g, 'γ')
        .replace(/\\delta\b/g, 'δ').replace(/\\epsilon\b/g, 'ε').replace(/\\zeta\b/g, 'ζ')
        .replace(/\\eta\b/g, 'η').replace(/\\theta\b/g, 'θ').replace(/\\iota\b/g, 'ι')
        .replace(/\\kappa\b/g, 'κ').replace(/\\lambda\b/g, 'λ').replace(/\\mu\b/g, 'μ')
        .replace(/\\nu\b/g, 'ν').replace(/\\xi\b/g, 'ξ').replace(/\\pi\b/g, 'π')
        .replace(/\\rho\b/g, 'ρ').replace(/\\sigma\b/g, 'σ').replace(/\\tau\b/g, 'τ')
        .replace(/\\upsilon\b/g, 'υ').replace(/\\phi\b/g, 'φ').replace(/\\chi\b/g, 'χ')
        .replace(/\\psi\b/g, 'ψ').replace(/\\omega\b/g, 'ω')
        .replace(/\\Gamma\b/g, 'Γ').replace(/\\Delta\b/g, 'Δ').replace(/\\Theta\b/g, 'Θ')
        .replace(/\\Lambda\b/g, 'Λ').replace(/\\Pi\b/g, 'Π').replace(/\\Sigma\b/g, 'Σ')
        .replace(/\\Phi\b/g, 'Φ').replace(/\\Psi\b/g, 'Ψ').replace(/\\Omega\b/g, 'Ω')
        .replace(/\\pm\b/g, '±').replace(/\\mp\b/g, '∓').replace(/\\times\b/g, '×')
        .replace(/\\div\b/g, '÷').replace(/\\cdot\b/g, '·').replace(/\\circ\b/g, '°')
        .replace(/\\leq\b/g, '≤').replace(/\\geq\b/g, '≥').replace(/\\neq\b/g, '≠')
        .replace(/\\approx\b/g, '≈').replace(/\\equiv\b/g, '≡').replace(/\\sim\b/g, '∼')
        .replace(/\\propto\b/g, '∝').replace(/\\infty\b/g, '∞')
        .replace(/\\rightarrow\b/g, '→').replace(/\\leftarrow\b/g, '←')
        .replace(/\\Rightarrow\b/g, '⇒').replace(/\\Leftarrow\b/g, '⇐')
        .replace(/\\to\b/g, '→').replace(/\\in\b/g, '∈').replace(/\\notin\b/g, '∉')
        .replace(/\\subset\b/g, '⊂').replace(/\\subseteq\b/g, '⊆')
        .replace(/\\cup\b/g, '∪').replace(/\\cap\b/g, '∩').replace(/\\emptyset\b/g, '∅')
        .replace(/\\forall\b/g, '∀').replace(/\\exists\b/g, '∃')
        .replace(/\\int\b/g, '∫').replace(/\\sum\b/g, 'Σ').replace(/\\prod\b/g, '∏')
        .replace(/\\partial\b/g, '∂').replace(/\\nabla\b/g, '∇')
        .replace(/\\angle\b/g, '∠').replace(/\\triangle\b/g, '△')
        .replace(/\\sin\b/g, 'sin').replace(/\\cos\b/g, 'cos').replace(/\\tan\b/g, 'tan')
        .replace(/\\log\b/g, 'log').replace(/\\ln\b/g, 'ln')
        .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '($1)/($2)')
        .replace(/\\sqrt\{([^}]+)\}/g, '√($1)')
        .replace(/\^\{([^}]+)\}/g, '^($1)').replace(/\_\{([^}]+)\}/g, '_($1)')
        .replace(/\\text\{([^}]+)\}/g, '$1').replace(/\\textbf\{([^}]+)\}/g, '**$1**')
        .replace(/\\textit\{([^}]+)\}/g, '*$1*')
        .replace(/\\displaystyle\b/g, '').replace(/\\left\b/g, '').replace(/\\right\b/g, '')
        .replace(/\$\$/g, '').replace(/\$/g, '').replace(/\\[a-zA-Z]+\b/g, '')
        .replace(/\s+/g, ' ').trim();
}

// ==================== RESPONSES API CALL ====================
function callResponsesAPI(conversationMessages, config, useWebSearch) {
    return new Promise((resolve, reject) => {
        const apiKey = process.env.GROK_API_KEY;
        
        const input = conversationMessages
            .filter(m => m.role !== 'system')
            .map(m => ({
                role: m.role === 'assistant' ? 'assistant' : 'user',
                content: typeof m.content === 'string' ? m.content : 
                    (Array.isArray(m.content) ? m.content.map(c => 
                        c.type === 'text' ? c.text : ''
                    ).join(' ') : '')
            }));
        
        const systemMsg = conversationMessages.find(m => m.role === 'system');
        if (systemMsg && input.length > 0) {
            input[0].content = systemMsg.content + '\n\n' + input[0].content;
        }
        
        const tools = useWebSearch ? [{ type: 'web_search' }] : [];
        
        const payload = JSON.stringify({
            model: config.model,
            input: input,
            tools: tools,
            max_output_tokens: config.maxTokens,
            temperature: config.temperature
        });
        
        const options = {
            hostname: 'api.x.ai',
            path: '/v1/responses',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(payload)
            }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode >= 400) {
                        reject({ status: res.statusCode, message: json.error?.message || json.detail || 'Unknown error' });
                    } else {
                        resolve(json);
                    }
                } catch(e) {
                    reject({ status: res.statusCode, message: 'Failed to parse response' });
                }
            });
        });
        
        req.on('error', (e) => reject({ message: e.message }));
        req.write(payload);
        req.end();
    });
}

// ==================== MAIN CHAT ENDPOINT ====================
app.post('/api/chat', async (req, res) => {
    try {
        const { messages, customInstructions, mode, agents, webSearch, image } = req.body;
        
        if (!process.env.GROK_API_KEY) {
            return res.status(500).json({ 
                reply: '⚠️ Grok API key not configured.',
                model: 'Error'
            });
        }
        
        const conversationMessages = [];
        
        if (customInstructions && customInstructions.trim()) {
            conversationMessages.push({
                role: 'system',
                content: customInstructions.trim()
            });
        }
        
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
        
        if (conversationMessages.length === 0) {
            conversationMessages.push({ role: 'user', content: 'Hello' });
        }
        
        const safeMode = mode || 'normal';
        const config = MODELS[safeMode] || MODELS.normal;
        
        const useWebSearch = webSearch === true;
        console.log(`🤖 Mode: ${safeMode} | Model: ${config.model} | Web: ${useWebSearch ? 'ON' : 'OFF'}`);
        
        let reply;
        
        if (safeMode === 'expert') {
            try {
                const responseData = await callResponsesAPI(conversationMessages, config, useWebSearch);
                reply = responseData.output_text || 
                        responseData.output?.find(o => o.type === 'message')?.content?.[0]?.text ||
                        'No response generated.';
            } catch(respErr) {
                console.error('Responses API failed:', respErr.message);
                throw respErr;
            }
        } else if (safeMode === 'smart') {
            const completion = await grok.chat.completions.create({
                model: config.model,
                messages: conversationMessages,
                max_tokens: config.maxTokens,
                temperature: config.temperature,
                reasoning_effort: 'high',
            });
            reply = completion?.choices?.[0]?.message?.content || 'No response generated.';
        } else {
            const completion = await grok.chat.completions.create({
                model: config.model,
                messages: conversationMessages,
                max_tokens: config.maxTokens,
                temperature: config.temperature,
            });
            reply = completion?.choices?.[0]?.message?.content || 'No response generated.';
        }
        
        reply = cleanLatex(reply);
        
        console.log(`✅ Response: ${reply.length} chars`);
        res.json({ reply, model: safeMode });
        
    } catch (error) {
        console.error('❌ Grok API Error:', error.message, error.status);
        
        let errorMessage = 'An error occurred. Please try again.';
        if (error.status === 401) errorMessage = '🔑 Invalid API key.';
        else if (error.status === 429) errorMessage = '⏳ Rate limited or out of credits.';
        else if (error.status === 402) errorMessage = '💰 Out of credits.';
        else if (error.status === 422) errorMessage = '⚠️ Invalid request. Try a different mode.';
        else if (error.status === 503) errorMessage = '🔧 Grok service unavailable.';
        else if (error.message?.includes('timeout')) errorMessage = '⏰ Request timed out.';
        else if (error.message) errorMessage = '⚠️ ' + error.message.substring(0, 100);
        
        res.status(500).json({ reply: errorMessage, model: 'Error' });
    }
});

// ==================== STATIC FILE ROUTES (for PWA) ====================

// Serve manifest.json with correct MIME type
app.get('/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

// Serve service worker
app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Service-Worker-Allowed', '/');
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// Serve offline page
app.get('/offline.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'offline.html'));
});

// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        app: 'GoldenSpaceAI2',
        provider: 'Grok (xAI)',
        mathCleaner: true,
        pwaReady: true,
        apiKeyConfigured: !!process.env.GROK_API_KEY
    });
});

// ==================== CATCH-ALL ROUTE ====================
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== ERROR HANDLING ====================
app.use((err, req, res, next) => {
    console.error('Error:', err.message);
    res.status(500).json({ reply: '⚠️ Server error.' });
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
    console.log('═══════════════════════════════');
    console.log('🚀 GoldenSpaceAI2 Server');
    console.log(`📡 Port: ${PORT}`);
    console.log(`🤖 Grok (xAI)`);
    console.log(`📐 Math Cleaner: ✅ Complete`);
    console.log(`📱 PWA Support: ✅ Ready`);
    console.log(`🔑 Key: ${process.env.GROK_API_KEY ? '✅' : '❌'}`);
    console.log('═══════════════════════════════');
});

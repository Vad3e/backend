const { spawn } = require('child_process');
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
const path = require('path');
const multer = require('multer');
const fs = require('fs'); 
const crypto = require('crypto');

// Import your custom email worker
const { sendEmail } = require('./mailer');

// ⚡ 1. IMPORT THE DNS MODULE & GLOBALLY FORCE IPv4
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ⚡ 2. FILE UPLOAD SETUP (MULTER)
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, uploadDir) },
    filename: function (req, file, cb) { 
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
        cb(null, Date.now() + '-' + safeName); 
    }
});
const upload = multer({ storage: storage });

// ⚡ 3. SECURE TiDB CONNECTION POOL (Crash-Proof)
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost', 
    user: process.env.DB_USER || 'root', 
    password: process.env.DB_PASSWORD || 'deploydesk', 
    database: process.env.DB_NAME || 'deploydesk_db',
    port: process.env.DB_PORT || 4000,
    ssl: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true
    },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
});

db.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Database pool connection failed:', err.message);
    } else {
        console.log('✅ Connected to MySQL Database Pool (System Online!)');
        connection.release(); 
    }
});

db.on('error', (err) => {
    if (err.code === 'PROTOCOL_CONNECTION_LOST') {
        console.error('⚠️ Database connection was closed by TiDB. The pool will automatically reconnect.');
    } else if (err.code === 'ECONNRESET') {
        console.error('⚠️ Database connection was reset. The pool will automatically reconnect.');
    } else {
        console.error('❌ Unexpected Database Error:', err);
    }
});

// ==========================================
// 1. AUTH & PASSWORD RESET ENDPOINTS
// ==========================================
// ==========================================
// 1. AUTH & PASSWORD RESET ENDPOINTS
// ==========================================
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    
    // ⚡ FIX: "ORDER BY id DESC LIMIT 1" ensures it always logs you into the newest, correct account and ignores old ghost duplicates.
    db.query('SELECT * FROM users WHERE email = ? ORDER BY id DESC LIMIT 1', [email], (err, results) => {
        if (err) { res.status(500).json({ success: false, message: 'Database error' }); return; }
        
        if (results.length > 0) {
            const user = results[0];
            const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
            
            if (user.password_hash === passwordHash || user.password_hash === password) {
                if (user.password_hash === password) {
                    db.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, user.id]);
                }
                res.json({ success: true, user: { id: user.id, email: user.email, name: user.full_name, role: user.role, contact: user.contact_number, position: user.position, avatar: user.avatar } });
            } else {
                res.status(401).json({ success: false, message: 'Invalid email or password' }); 
            }
        } else { 
            res.status(401).json({ success: false, message: 'Invalid email or password' }); 
        }
    });
});

app.post('/api/signup', (req, res) => {
    // ... (Keep your existing /api/signup code here exactly as it is) ...
    console.log('\n[SIGNUP] 🔄 Received new signup request!');
    const { email, password, fullName, contact, role, memberPosition } = req.body;

    if (!email || !password || !fullName) {
        console.log('[SIGNUP] ❌ Failed: Missing required fields');
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    try {
        db.query('SELECT id FROM users WHERE email = ?', [email], (err, results) => {
            if (err) return res.status(500).json({ success: false, message: 'Database error' });
            if (results.length > 0) return res.status(400).json({ success: false, message: 'Email is already registered' });

            const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
            const sql = 'INSERT INTO users (full_name, email, contact_number, password_hash, role, position) VALUES (?, ?, ?, ?, ?, ?)';
            const params = [fullName, email, contact || null, passwordHash, role, memberPosition || null];

            db.query(sql, params, (insertErr, result) => {
                if (insertErr) return res.status(500).json({ success: false, message: 'Database error creating user' });

                console.log(`[SIGNUP] ✅ User saved to DB! New ID: ${result.insertId}`);

                const welcomeHtml = `
                    <div style="font-family: Arial; padding: 20px; color: #111;">
                        <h2>Welcome to DeployDesk, ${fullName}!</h2>
                        <p>Your account has been successfully created.</p>
                        <p><strong>Role:</strong> ${role.toUpperCase()}</p>
                        <p>You can now log in to access the workspace.</p>
                    </div>`;
                sendEmail(email, 'Welcome to DeployDesk!', welcomeHtml);

                db.query('SELECT id, full_name as name, email, role, position, contact_number as contact, avatar FROM users WHERE id = ?', [result.insertId], (fetchErr, newUsers) => {
                    if (fetchErr) return res.status(500).json({ success: false, message: 'Account created but failed to load data.' });
                    console.log('[SIGNUP] 🎉 Sign up completely successful! Sending data to frontend.');
                    res.json({ success: true, user: newUsers[0] });
                });
            });
        });
    } catch (catchedErr) {
        res.status(500).json({ success: false, message: 'Server crash' });
    }
});

app.post('/api/forgot-password', (req, res) => {
    const { email } = req.body;
    db.query('SELECT id, full_name FROM users WHERE email = ?', [email], (err, users) => {
        if (err || users.length === 0) { res.json({ success: true }); return; } 
        const token = crypto.randomBytes(32).toString('hex');
        const expires = Date.now() + 3600000; 
        
        // ⚡ FIX: Send token to ALL accounts matching the email
        db.query('UPDATE users SET reset_token = ?, reset_expires = ? WHERE email = ?', [token, expires, email], (err) => {
            if (err) { res.status(500).json({ success: false }); return; }
            
            const resetLink = `https://deploydesk.netlify.app/confirmationpass.html?token=${token}`;
            
            const emailHtml = `
                <div style="font-family: 'Arial', sans-serif; color: #111; max-width: 500px; padding: 20px; border: 1px solid #e0e0e0; border-radius: 12px;">
                    <h2 style="color: #1BA354; margin-top: 0;">Password Reset Request</h2>
                    <p style="font-size: 15px; line-height: 1.6;">Hello,</p>
                    <p style="font-size: 15px; line-height: 1.6;">You recently requested to reset your password for your DeployDesk account. Click the button below to securely set a new password.</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${resetLink}" style="display: inline-block; padding: 14px 28px; background-color: #1BA354; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">Reset My Password</a>
                    </div>
                    <p style="font-size: 13px; color: #888; margin-bottom: 0;">If you did not request a password reset, you can safely ignore this email. This link will expire in 1 hour.</p>
                </div>
            `;
            
            sendEmail(email, 'DeployDesk: Password Reset Request', emailHtml);
            res.json({ success: true });
        });
    });
});

app.post('/api/reset-password', (req, res) => {
    const { token, newPassword } = req.body;
    
    // ⚡ FIX: Grab the email linked to the token to safely wipe out all duplicates
    db.query('SELECT email FROM users WHERE reset_token = ? AND reset_expires > ? LIMIT 1', [token, Date.now()], (err, users) => {
        if (err || users.length === 0) { res.status(400).json({ success: false, message: 'Invalid or expired link.' }); return; }
        
        const passwordHash = crypto.createHash('sha256').update(newPassword).digest('hex');
        const userEmail = users[0].email;
        
        // ⚡ FIX: Forcefully update the password for EVERY row matching this email
        db.query('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE email = ?', [passwordHash, userEmail], (err) => {
            res.json({ success: !err });
        });
    });
});
// ==========================================
// ⚡ GLOBAL SYSTEM SETTINGS ENDPOINTS
// ==========================================
app.get('/api/settings', (req, res) => {
    db.query('SELECT * FROM system_settings', (err, results) => {
        if (err) return res.status(500).json({ success: false });
        const settings = {};
        results.forEach(row => {
            try { settings[row.setting_key] = JSON.parse(row.setting_value); }
            catch(e) { settings[row.setting_key] = row.setting_value; }
        });
        res.json({ success: true, settings });
    });
});

app.post('/api/settings', (req, res) => {
    const { settings } = req.body;
    const queries = [];
    for (const [key, value] of Object.entries(settings)) {
        queries.push(new Promise((resolve, reject) => {
            db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?', 
            [key, JSON.stringify(value), JSON.stringify(value)], (err) => {
                if(err) reject(err); else resolve();
            });
        }));
    }
    Promise.all(queries).then(() => res.json({ success: true })).catch(() => res.status(500).json({ success: false }));
});

// ==========================================
// 2. EVENTS & PYTHON CCAA 
// ==========================================
app.get('/api/events', (req, res) => {
    db.query(`SELECT e.*, u.full_name as requester_name FROM event_requests e LEFT JOIN users u ON e.requester_id = u.id ORDER BY e.event_date ASC`, (err, results) => {
        res.json({ success: !err, events: results });
    });
});

app.post('/api/events/delete', (req, res) => {
    db.query(`DELETE FROM notifications WHERE event_id = ?`, [req.body.eventId], (err) => {
        db.query(`DELETE FROM event_requests WHERE id = ?`, [req.body.eventId], (err) => {
            res.json({ success: !err, message: 'Event Deleted' });
        });
    });
});

app.post('/api/events', upload.array('files', 10), (req, res) => {
    const { title, date, time, venue, members, type, requesterId } = req.body;
    let baseDescription = req.body.description || '';
    const personnelReqs = req.body.personnelReqs || '[]'; 
    const reqCode = 'REQ-' + Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 9); 

    if (req.files && req.files.length > 0) {
        baseDescription += `\n\n[Attached Documents]:`;
        req.files.forEach(file => {
            baseDescription += `\n<a href="/uploads/${file.filename}" target="_blank" style="color:#1BA354;">📄 ${file.originalname}</a>`;
        });
    }

    const safeRequesterId = parseInt(requesterId) || 0;
    const safeMembers = parseInt(members) || 1;
    const safeType = type || 'Event';
    const defaultApprovals = JSON.stringify({ initial: [], forwarded: [], final: [] });

    const query = `INSERT INTO event_requests (req_code, title, description, requester_id, event_date, start_time, venue, members_required, event_type, status, algo_status, personnel_reqs, admin_approvals) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_initial_admin', 'clear', ?, ?)`;
    const values = [reqCode, title, baseDescription, safeRequesterId, date, time, venue, safeMembers, safeType, personnelReqs, defaultApprovals];

    db.query(query, values, (err, result) => {
        if (err) {
            console.error('❌ MYSQL ERROR:', err.message);
            return res.status(500).json({ success: false }); 
        }

        const eventId = result.insertId;
        
        try {
            const parsedReqs = JSON.parse(personnelReqs);
            if (parsedReqs && parsedReqs.length > 0) {
                const pythonProcess = spawn('python3', ['ccaa_engine.py', eventId, personnelReqs]);
                pythonProcess.stdout.on('data', (data) => console.log(`🐍 Python Engine: ${data}`));
                pythonProcess.stderr.on('data', (data) => console.error(`❌ Python Error: ${data}`));
            }
        } catch(e) {}

        // ✉️ TRIGGER 3: Admin Notified of New Request
        db.query(`SELECT id, position, email FROM users WHERE role = 'admin'`, (err, admins) => {
            if (admins && admins.length > 0) {
                admins.forEach(admin => {
                    db.query(`INSERT INTO notifications (user_id, message, type, event_id) VALUES (?, ?, 'warning', ?)`, [admin.id, `New Ticket: Event "${title}" needs your initial approval.`, eventId], () => {});
                    if(admin.email) {
                        sendEmail(admin.email, 'DeployDesk: New Ticket Requires Approval', `<div style="font-family:Arial; color:#333;"><p>Hello Admin,</p><p>A new event request <b>"${title}"</b> has been submitted and requires your initial approval before the matching engine can run.</p></div>`);
                    }
                });
            }
        });

        // ✉️ TRIGGER 2: Requester Notified of Submission
        db.query('INSERT INTO notifications (user_id, message, type, event_id) VALUES (?, ?, ?, ?)', [safeRequesterId, `Ticket Submitted: Your request for "${title}" is awaiting initial admin review.`, 'info', eventId], () => {});
        db.query('SELECT email, full_name FROM users WHERE id = ?', [safeRequesterId], (err, users) => {
            if(users && users.length > 0) {
                sendEmail(users[0].email, 'DeployDesk: Ticket Submitted', `<div style="font-family:Arial; color:#333;"><p>Hello ${users[0].full_name},</p><p>Your event request <b>"${title}"</b> has been successfully submitted and is now awaiting admin review.</p></div>`);
            }
        });
        
        res.json({ success: true });
    });
});

app.post('/api/events/roster', (req, res) => {
    const { eventId, selectedAllocations, myOrg } = req.body;
    
    db.query(`SELECT personnel_reqs, admin_approvals FROM event_requests WHERE id = ?`, [eventId], (err, rows) => {
        if (err || rows.length === 0) return res.status(500).json({ success: false });
        let ev = rows[0];
        
        let approvals = { initial: [], forwarded: [], final: [] };
        try { if (ev.admin_approvals) approvals = JSON.parse(ev.admin_approvals); } catch(e) {}
        if (!approvals.forwarded) approvals.forwarded = [];

        let reqs = [];
        try { if (ev.personnel_reqs) reqs = JSON.parse(ev.personnel_reqs); } catch(e) {}
        let requiredOrgs = [...new Set(reqs.map(r => r.group))];

        if (myOrg && !approvals.forwarded.includes(myOrg)) approvals.forwarded.push(myOrg);
        
        if (selectedAllocations && selectedAllocations.length > 0) {
            db.query(`UPDATE event_allocations SET status = 'rostered' WHERE id IN (?)`, [selectedAllocations], () => {});
        }

        const isFullyForwarded = requiredOrgs.every(org => approvals.forwarded.includes(org));
        
        db.query(`UPDATE event_requests SET admin_approvals = ? WHERE id = ?`, [JSON.stringify(approvals), eventId], () => {
            if (isFullyForwarded) {
                db.query(`UPDATE event_requests SET status = 'pending_admin' WHERE id = ?`, [eventId], () => {
                    
                    // ✉️ TRIGGER 5: Roster Selection Forwarded
                    db.query(`SELECT id, email FROM users WHERE role = 'admin'`, (err, topAdmins) => {
                        if (topAdmins && topAdmins.length > 0) {
                            topAdmins.forEach(admin => {
                                db.query(`INSERT INTO notifications (user_id, message, type, event_id) VALUES (?, ?, 'warning', ?)`, [admin.id, `Action Required: Event ID ${eventId} has a roster ready for final approval.`, eventId], () => {});
                            });
                            const emails = topAdmins.map(a => a.email).filter(e => e).join(',');
                            if(emails) sendEmail(emails, `DeployDesk: Roster Ready for Review`, `<div style="font-family:Arial; color:#333;"><p>Hello Admin,</p><p>The administrative assistants have finalized the roster for Event ID: <b>${eventId}</b>. It now requires your final deployment approval.</p></div>`);
                        }
                    });
                    
                    res.json({ success: true, message: "Roster fully forwarded to Admins!" });
                });
            } else {
                res.json({ success: true, message: `Your org's roster forwarded. Waiting for Partner Admin Assistant.` });
            }
        });
    });
});

app.post('/api/events/status', (req, res) => {
    const { eventId, status, selectedAllocations, myOrg } = req.body;

    db.query(`SELECT personnel_reqs, admin_approvals, title FROM event_requests WHERE id = ?`, [eventId], (err, rows) => {
        if (err || rows.length === 0) return res.status(500).json({ success: false });
        let ev = rows[0];
        
        let approvals = { initial: [], forwarded: [], final: [] };
        try { if (ev.admin_approvals) approvals = JSON.parse(ev.admin_approvals); } catch(e) {}
        
        let reqs = [];
        try { if (ev.personnel_reqs) reqs = JSON.parse(ev.personnel_reqs); } catch(e) {}
        let requiredOrgs = [...new Set(reqs.map(r => r.group))]; 

        if (status === 'initial_approve') {
            if (myOrg && !approvals.initial.includes(myOrg)) approvals.initial.push(myOrg);
            const isFullyApproved = requiredOrgs.every(org => approvals.initial.includes(org));

            db.query(`UPDATE event_requests SET admin_approvals = ? WHERE id = ?`, [JSON.stringify(approvals), eventId], () => {
                if (isFullyApproved) {
                    db.query(`UPDATE event_requests SET status = 'pending' WHERE id = ?`, [eventId], () => {
                        db.query(`UPDATE event_allocations SET status = 'notified' WHERE event_id = ? AND status = 'eligible'`, [eventId], () => {
                            
                            // ✉️ TRIGGER 4: Members Received Initial Approval (CCAA Match)
                            db.query(`SELECT a.user_id, u.email, u.full_name FROM event_allocations a JOIN users u ON a.user_id = u.id WHERE a.event_id = ? AND a.status = 'notified'`, [eventId], (err, allocations) => {
                                if (allocations) {
                                    allocations.forEach(a => {
                                        db.query("INSERT INTO notifications (user_id, message, type, event_id) VALUES (?, ?, 'info', ?)", [a.user_id, `⚡ CCAA Alert: You match the required schedule for '${ev.title}'. Check dashboard!`, eventId], () => {});
                                        sendEmail(a.email, 'DeployDesk: New Coverage Match!', `<div style="font-family:Arial; color:#333;"><p>Hello ${a.full_name},</p><p>You match the schedule requirements for <b>"${ev.title}"</b>! Please log into your dashboard to accept or decline the task.</p></div>`);
                                    });
                                }
                            });
                            
                        });
                    });
                    res.json({ success: true, message: "Initial approval granted. Members notified." });
                } else {
                    res.json({ success: true, message: "Approval saved. Waiting for Partner Admin." });
                }
            });
        } 
        else if (status === 'approved') {
            if (myOrg && !approvals.final.includes(myOrg)) approvals.final.push(myOrg);
            
            if (selectedAllocations && selectedAllocations.length > 0) {
                db.query(`UPDATE event_allocations SET status = 'assigned' WHERE id IN (?)`, [selectedAllocations], () => {});
            }

            const isFullyApproved = requiredOrgs.every(org => approvals.final.includes(org));
            db.query(`UPDATE event_requests SET admin_approvals = ? WHERE id = ?`, [JSON.stringify(approvals), eventId], () => {
                if (isFullyApproved) {
                    db.query(`UPDATE event_requests SET status = 'approved' WHERE id = ?`, [eventId], () => {
                        
                        db.query(`SELECT u.full_name, u.email, ea.required_role, u.id as user_id FROM event_allocations ea JOIN users u ON ea.user_id = u.id WHERE ea.event_id = ? AND ea.status = 'assigned'`, [eventId], (err, memberDetails) => {
                            if (memberDetails) {
                                let teamListHtml = '<ul style="background: #f4f4f4; padding: 15px; border-radius: 8px; list-style: none;">';
                                
                                // ✉️ TRIGGER 6: Admin Approval (Members officially assigned)
                                memberDetails.forEach(m => { 
                                    teamListHtml += `<li style="margin-bottom: 8px;">✅ <strong>${m.full_name}</strong> — ${m.required_role}</li>`; 
                                    db.query(`INSERT INTO notifications (user_id, message, type, event_id) VALUES (?, ?, 'success', ?)`, [m.user_id, `You have been officially ASSIGNED to cover an event!`, eventId]);
                                    sendEmail(m.email, 'DeployDesk: Official Assignment', `<div style="font-family:Arial; color:#333;"><p>Hello ${m.full_name},</p><p>You have been officially <b>ASSIGNED</b> to cover <b>"${ev.title}"</b> as <b>${m.required_role}</b>. Please check your schedule.</p></div>`);
                                });
                                teamListHtml += '</ul>';

                                // ✉️ TRIGGER 7a: Request is Approved (for the Requester)
                                db.query(`SELECT u.email, u.full_name, e.title, e.requester_id FROM event_requests e JOIN users u ON e.requester_id = u.id WHERE e.id = ?`, [eventId], (err, results) => {
                                    if (results && results.length > 0) {
                                        const requester = results[0];
                                        db.query(`INSERT INTO notifications (user_id, message, type, event_id) VALUES (?, ?, 'success', ?)`, [requester.requester_id, `Event Approved! The coverage team for "${requester.title}" has been assigned.`, eventId]);
                                        sendEmail(requester.email, `DeployDesk: Event Approved (${requester.title})`, `
                                            <div style="font-family: Arial, sans-serif; color: #333;">
                                                <p>Hello <strong>${requester.full_name}</strong>,</p>
                                                <p>Your event "<strong>${requester.title}</strong>" has been <span style="color: #1BA354; font-weight: bold;">OFFICIALLY APPROVED</span>.</p>
                                                <p>The following coverage team has been assigned:</p>
                                                ${teamListHtml}
                                            </div>
                                        `);
                                    }
                                });
                            }
                        });
                    });
                    res.json({ success: true, message: "Event officially deployed!" });
                } else {
                    res.json({ success: true, message: "Your team is assigned. Waiting for Partner Admin." });
                }
            });
        } else {
            // Rejections and other arbitrary status updates
            db.query(`UPDATE event_requests SET status = ? WHERE id = ?`, [status, eventId], () => { 
                
                // ✉️ TRIGGER 7b: Request is Rejected (for the Requester)
                if (status === 'rejected') {
                    db.query(`SELECT u.email, u.full_name, e.title, e.requester_id FROM event_requests e JOIN users u ON e.requester_id = u.id WHERE e.id = ?`, [eventId], (err, results) => {
                        if (results && results.length > 0) {
                            const requester = results[0];
                            db.query(`INSERT INTO notifications (user_id, message, type, event_id) VALUES (?, ?, 'error', ?)`, [requester.requester_id, `Event Rejected: Your request for "${requester.title}" was declined.`, eventId]);
                            sendEmail(requester.email, `DeployDesk: Event Update (${requester.title})`, `
                                <div style="font-family: Arial, sans-serif; color: #333;">
                                    <p>Hello <strong>${requester.full_name}</strong>,</p>
                                    <p>Unfortunately, your event request for "<strong>${requester.title}</strong>" has been <span style="color: #d02020; font-weight: bold;">REJECTED</span> or CANCELLED by the administration.</p>
                                    <p>If you have any questions or need to submit a revised request, please contact the organization administrators.</p>
                                </div>
                            `);
                        }
                    });
                }
                
                res.json({ success: true, message: `Status updated to ${status}!` }); 
            });
        }
    });
});

// ==========================================
// 3. ALLOCATIONS & ADMIN DIRECTORY
// ==========================================
app.get('/api/allocations/member/:userId', (req, res) => {
    db.query(`SELECT a.*, e.title, e.event_date, e.start_time, e.venue, e.status as event_status FROM event_allocations a JOIN event_requests e ON a.event_id = e.id WHERE a.user_id = ?`, [req.params.userId], (err, results) => {
        res.json({ success: !err, tasks: results });
    });
});
app.post('/api/allocations/accept', (req, res) => { db.query(`UPDATE event_allocations SET status = 'accepted' WHERE id = ?`, [req.body.allocationId], (err) => res.json({ success: !err })); });
app.post('/api/allocations/decline', (req, res) => { db.query(`UPDATE event_allocations SET status = 'declined' WHERE id = ?`, [req.body.allocationId], (err) => res.json({ success: !err })); });

app.get('/api/allocations/admin/:eventId', (req, res) => {
    db.query(`SELECT a.*, u.full_name as user_name, (SELECT COUNT(*) FROM event_allocations ea JOIN event_requests er ON ea.event_id = er.id WHERE ea.user_id = a.user_id AND ea.status = 'assigned' AND er.status = 'approved') as current_workload FROM event_allocations a JOIN users u ON a.user_id = u.id WHERE a.event_id = ?`, [req.params.eventId], (err, results) => {
        res.json({ success: !err, allocations: results });
    });
});

app.get('/api/users', (req, res) => { 
    db.query(`SELECT id, full_name, email, role, contact_number, position, created_at FROM users ORDER BY created_at DESC`, (err, results) => {
        res.json({ success: !err, users: results });
    }); 
});
app.post('/api/users/upgrade', (req, res) => { db.query(`UPDATE users SET role = 'administrative' WHERE id = ?`, [req.body.userId], (err) => res.json({ success: !err })); });
app.post('/api/users/demote', (req, res) => { db.query(`UPDATE users SET role = 'member' WHERE id = ?`, [req.body.userId], (err) => res.json({ success: !err })); });

app.post('/api/users/update', (req, res) => {
    const { userId, fullName, contact, position, avatar } = req.body;
    let sql = 'UPDATE users SET full_name = ?, contact_number = ?, position = ?';
    let params = [fullName, contact, position];
    if (avatar) {
        sql += ', avatar = ?';
        params.push(avatar);
    }
    sql += ' WHERE id = ?';
    params.push(userId);

    db.query(sql, params, (err, result) => {
        if (err) {
            console.error('❌ Update Profile Error:', err);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        res.json({ success: true });
    });
});

app.post('/api/users/remove', (req, res) => {
    const uid = req.body.userId;
    db.query(`DELETE FROM event_allocations WHERE user_id = ?`, [uid], () => {
        db.query(`DELETE FROM user_schedules WHERE user_id = ?`, [uid], () => {
            db.query(`DELETE FROM notifications WHERE user_id = ?`, [uid], () => {
                db.query(`DELETE FROM users WHERE id = ?`, [uid], (err) => res.json({ success: !err }));
            });
        });
    });
});

// ==========================================
// 4. UTILS, SCHEDULE, AND NOTIFICATIONS
// ==========================================
app.get('/api/workload-ranking', (req, res) => {
    db.query(`SELECT u.id, u.full_name, u.position, u.role, (SELECT COUNT(*) FROM event_allocations ea JOIN event_requests er ON ea.event_id = er.id WHERE ea.user_id = u.id AND ea.status = 'assigned' AND er.status = 'approved' AND er.event_date >= CURDATE()) as active_tasks FROM users u WHERE u.role IN ('member', 'administrative') ORDER BY active_tasks DESC, u.full_name ASC`, (err, results) => {
        res.json({ success: !err, ranking: results });
    });
});

app.get('/api/stats', (req, res) => {
    db.query(`SELECT (SELECT COUNT(*) FROM event_requests) AS totalEvents, (SELECT COUNT(*) FROM event_requests WHERE status = 'pending_admin') AS pendingEvents, (SELECT COUNT(*) FROM event_requests WHERE status = 'approved') AS approvedEvents, (SELECT COUNT(*) FROM users WHERE role IN ('member', 'administrative')) AS totalMembers`, (err, results) => res.json({ success: !err, stats: results ? results[0] : {} }));
});

app.get('/api/user-stats/:userId', (req, res) => {
    db.query(`SELECT COUNT(*) as totalAssigned, SUM(CASE WHEN e.event_date >= CURDATE() THEN 1 ELSE 0 END) as upcomingEvents FROM event_allocations a JOIN event_requests e ON a.event_id = e.id WHERE a.user_id = ? AND a.status = 'assigned' AND e.status = 'approved'`, [req.params.userId], (err, results) => res.json({ success: !err, stats: results ? results[0] : {} }));
});

app.post('/api/schedule', (req, res) => {
    db.query('DELETE FROM user_schedules WHERE user_id = ?', [req.body.userId], (err) => {
        if (!req.body.busySlots || req.body.busySlots.length === 0) return res.json({ success: true });
        const values = req.body.busySlots.map(slot => [req.body.userId, slot.day, slot.hour]);
        db.query('INSERT INTO user_schedules (user_id, day_of_week, hour_of_day) VALUES ?', [values], (err) => res.json({ success: !err }));
    });
});

app.get('/api/schedule/:userId', (req, res) => { db.query('SELECT day_of_week as day, hour_of_day as hour FROM user_schedules WHERE user_id = ?', [req.params.userId], (err, results) => res.json({ success: !err, schedule: results })); });
app.get('/api/notifications/:userId', (req, res) => { db.query('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC', [req.params.userId], (err, results) => res.json({ success: !err, notifications: results })); });
app.post('/api/notifications/read', (req, res) => { db.query(`UPDATE notifications SET is_read = TRUE WHERE id = ?`, [req.body.notifId], (err) => res.json({ success: !err })); });
app.post('/api/notifications/read-all', (req, res) => { db.query(`UPDATE notifications SET is_read = TRUE WHERE user_id = ?`, [req.body.userId], (err) => res.json({ success: !err })); });

// ⚡ FIX: Endpoint to save live Service Request Tracking updates
app.post('/api/events/service-status', (req, res) => {
    const { eventId, serviceStatus, postingDate } = req.body;
    
    const sql = `UPDATE events SET service_status = ?, posting_date = ? WHERE id = ?`;
    db.query(sql, [serviceStatus, postingDate || null, eventId], (err) => {
        if (err) {
            // Auto-heal: If columns don't exist yet, create them on the fly and retry!
            if (err.code === 'ER_BAD_FIELD_ERROR') {
                db.query(`ALTER TABLE events ADD COLUMN service_status VARCHAR(50) DEFAULT 'upcoming', ADD COLUMN posting_date DATE`, (alterErr) => {
                    if (alterErr) return res.json({success: false, message: 'Database Error'});
                    db.query(sql, [serviceStatus, postingDate || null, eventId], (retryErr) => {
                        res.json({success: !retryErr});
                    });
                });
            } else {
                res.json({success: false});
            }
        } else {
            res.json({ success: true });
        }
    });
});
// ⚡ FIX 1: Make sure the database actually FETCHES the service_status columns for the member!
app.get('/api/allocations/member/:id', (req, res) => {
    const sql = `
        SELECT a.*, e.title, e.event_date, e.start_time, e.venue, e.status as event_status, 
               e.service_status, e.posting_date 
        FROM personnel_allocations a 
        JOIN events e ON a.event_id = e.id 
        WHERE a.user_id = ?`;
        
    db.query(sql, [req.params.id], (err, results) => {
        res.json({ success: !err, tasks: results || [] });
    });
});

// ⚡ FIX 2: Bulletproof the Save Endpoint to handle MySQL strict mode safely
app.post('/api/events/service-status', (req, res) => {
    const { eventId, serviceStatus, postingDate } = req.body;
    
    // Force empty strings to be strict SQL NULLs to prevent crash
    const safeDate = (postingDate && postingDate.trim() !== '') ? postingDate : null;
    
    const sql = `UPDATE events SET service_status = ?, posting_date = ? WHERE id = ?`;
    db.query(sql, [serviceStatus, safeDate, eventId], (err) => {
        if (err) {
            if (err.code === 'ER_BAD_FIELD_ERROR') {
                db.query(`ALTER TABLE events ADD COLUMN service_status VARCHAR(50) DEFAULT 'upcoming', ADD COLUMN posting_date DATE`, (alterErr) => {
                    if (alterErr) return res.json({success: false, message: 'Failed to create DB columns'});
                    db.query(sql, [serviceStatus, safeDate, eventId], (retryErr) => {
                        res.json({success: !retryErr, message: retryErr ? retryErr.message : ''});
                    });
                });
            } else {
                res.json({success: false, message: err.message});
            }
        } else {
            res.json({ success: true });
        }
    });
});
app.listen(3000, () => console.log(`🚀 Server running on http://localhost:3000`));
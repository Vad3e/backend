// mailer.js
const nodemailer = require('nodemailer');

// Set up the Nodemailer transporter using your environment variables
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,    
        pass: process.env.EMAIL_PASS     
    }
});

/**
 * Reusable function to send emails from anywhere in your app.
 * @param {string} to - The recipient's email address
 * @param {string} subject - The subject line of the email
 * @param {string} htmlContent - The HTML body of the email
 */
async function sendEmail(to, subject, htmlContent) {
    if (!to) {
        console.error('[EMAIL] ❌ FAILED: No recipient address provided.');
        return false;
    }
    
    console.log(`\n[EMAIL] 🔄 Attempting to send email to: ${to} via Nodemailer`);

    try {
        await transporter.sendMail({ 
            from: `"DeployDesk" <${process.env.EMAIL_USER}>`, 
            to: to, 
            subject: subject, 
            html: htmlContent 
        });
        console.log(`[EMAIL] ✅ SUCCESS: Delivered to ${to}`);
        return true;
    } catch (error) {
        console.error('[EMAIL] ❌ FAILED:', error.message);
        return false;
    }
}

// Export the function so other files (like server.js) can use it
module.exports = { sendEmail };
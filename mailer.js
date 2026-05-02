const nodemailer = require('nodemailer');

// 1. Configure the SMTP Transport
const transporter = nodemailer.createTransport({
    host: 'smtp-relay.brevo.com', // Brevo's default SMTP server
    port: 2525,                    // Standard secure port
    secure: false,                // Keep false for port 587
    auth: {
        user: process.env.SMTP_USER, 
        pass: process.env.SMTP_PASS  
    },
    family: 4 // Forces IPv4 connection to prevent server timeout errors
});

// 2. Verify the connection on startup
transporter.verify((error, success) => {
    if (error) {
        console.error('❌ Brevo SMTP Connection Error:', error);
    } else {
        console.log('✅ Connected to Brevo SMTP Server (Ready to send emails!)');
    }
});

// 3. Create a reusable function to send emails
const sendEmail = (toEmail, subject, htmlContent) => {
    const mailOptions = {
        from: '"DeployDesk Notifications" <your_verified_sender@example.com>', // Replace with your verified Brevo sender email
        to: toEmail,
        subject: subject,
        html: htmlContent
    };

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.error(`[EMAIL] ❌ FAILED sending to ${toEmail}:`, error.message);
        } else {
            console.log(`[EMAIL] ✉️ SENT to ${toEmail} | ID: ${info.messageId}`);
        }
    });
};

// 4. Export the function for use in server.js
module.exports = { sendEmail };

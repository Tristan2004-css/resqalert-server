const express = require("express");
const admin = require("firebase-admin");

// --- Firebase Admin initialization using environment variables ---

// Make sure you set these environment variables in Render:
// FIREBASE_PROJECT_ID
// FIREBASE_CLIENT_EMAIL
// FIREBASE_PRIVATE_KEY
// FIREBASE_DATABASE_URL

const serviceAccount = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    // Render will store the private key with literal \n, so we replace them
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
};

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
});

const db = admin.database();
const messaging = admin.messaging();

const app = express();
app.use(express.json());

// Simple health endpoint for testing
app.get("/", (req, res) => {
    res.send("ResQAlert notification server is running.");
});

/**
 * Build a high-priority FCM multicast message.
 *
 * @param {{title:string, body:string, tokens:string[], alertId:string, alert:object}} params
 * @return {object}
 */
function buildAlertMessage(params) {
    const title = params.title;
    const body = params.body;
    const tokens = params.tokens;
    const alertId = params.alertId;
    const alert = params.alert || {};

    return {
        tokens: tokens,
        notification: {
            title: title,
            body: body,
        },
        android: {
            priority: "high",
            notification: {
                channelId: "emergency_alerts_channel",
                sound: "alarm", // android/app/src/main/res/raw/alarm.mp3
                color: "#C82323",
                defaultVibrateTimings: true,
                visibility: "public",
                notificationPriority: "PRIORITY_MAX",
            },
        },
        apns: {
            headers: {
                "apns-priority": "10",
            },
            payload: {
                aps: {
                    alert: {
                        title: title,
                        body: body,
                    },
                    sound: "default",
                    "content-available": 1,
                },
            },
        },
        data: {
            click_action: "FLUTTER_NOTIFICATION_CLICK",
            type: "EMERGENCY",
            alertId: String(alertId),
            category: String(alert.category || ""),
            emergency: String(alert.emergency || ""),
            building: String(alert.building || ""),
            floor: String(alert.floor || ""),
            room: String(alert.room || ""),
        },
    };
}

/**
 * Listen for new alerts in RTDB and send FCM.
 *
 * Path: /alerts/{alertId}
 */
function startAlertListener() {
    const alertsRef = db.ref("alerts");

    // child_added fires for existing children AND new ones.
    alertsRef.on("child_added", async (snapshot) => {
        const alertId = snapshot.key;
        const alert = snapshot.val() || {};

        console.log("New alert detected:", alertId, alert);

        // Skip resolved / closed alerts
        const status = String(alert.status || "").toLowerCase();
        if (status === "resolved" || status === "closed") {
            console.log("Alert is resolved/closed – no FCM sent:", alertId);
            return;
        }

        // Optional: prevent double-sending using a processed flag
        const processed = alert.processed === true;
        if (processed) {
            console.log("Alert already processed – skipping:", alertId);
            return;
        }

        // 1️⃣ Read all user tokens
        const tokensSnap = await db.ref("userTokens").get();

        if (!tokensSnap.exists()) {
            console.warn("No userTokens found; skip sending FCM.");
            return;
        }

        const tokensData = tokensSnap.val();
        const tokenEntries = Object.entries(tokensData); // [ [uid, {token}], ... ]

        const tokens = tokenEntries
            .map((entry) => {
                const value = entry[1];
                return value && value.token ? String(value.token) : null;
            })
            .filter((t) => t && t.length > 0);

        if (tokens.length === 0) {
            console.warn("No valid tokens after filtering; skip FCM.");
            return;
        }

        // 2️⃣ Build title/body
        const title = `🚨 ${alert.emergency || "Emergency"}`;

        const bodyParts = [];
        if (alert.message) bodyParts.push(String(alert.message));
        if (alert.building) bodyParts.push(String(alert.building));
        if (alert.floor) bodyParts.push(String(alert.floor));
        if (alert.room) bodyParts.push(String(alert.room));
        const body = bodyParts.join(" • ") || "Emergency alert";

        // 3️⃣ Build & send multicast message
        const message = buildAlertMessage({
            title: title,
            body: body,
            tokens: tokens,
            alertId: alertId,
            alert: alert,
        });

        try {
            const response = await messaging.sendEachForMulticast(message);

            console.log("FCM sendEachForMulticast result", {
                successCount: response.successCount,
                failureCount: response.failureCount,
            });

            // 4️⃣ Optional: clean up invalid tokens
            const tokensRef = db.ref("userTokens");
            const removals = [];

            response.responses.forEach((r, index) => {
                if (!r.success && r.error) {
                    const code = r.error.code || "";
                    const isBadToken =
                        code === "messaging/invalid-registration-token" ||
                        code === "messaging/registration-token-not-registered";

                    if (isBadToken) {
                        const uid = tokenEntries[index][0];
                        console.warn("Removing invalid token", { uid: uid, code: code });
                        removals.push(tokensRef.child(uid).remove());
                    } else {
                        console.warn("FCM send error", {
                            index: index,
                            token: tokens[index],
                            code: code,
                            message: r.error.message,
                        });
                    }
                }
            });

            if (removals.length > 0) {
                await Promise.all(removals);
                console.log("Invalid tokens removed", { count: removals.length });
            }

            // Mark alert as processed to avoid duplicates
            await db.ref(`alerts/${alertId}/processed`).set(true);
        } catch (err) {
            console.error("Error sending FCM", err);
        }
    });
}

// Start listener
startAlertListener();

// Start HTTP server (Render needs this)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`ResQAlert server listening on port ${PORT}`);
});

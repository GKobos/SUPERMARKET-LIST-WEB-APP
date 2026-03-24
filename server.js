require("dotenv").config();
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const cookieParser = require("cookie-parser");
const express = require("express");
const path = require("path");
const dbPath = path.join(__dirname, "SuperMarket.db");
const db = require("better-sqlite3")(dbPath);

try {
    db.pragma("journal_mode = WAL");
} catch (err) {
    console.error("SQLite PRAGMA failed:", err);
}

// --- DATABASE SETUP ---
const createTables = db.transaction(() => {
    db.prepare(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username STRING NOT NULL UNIQUE,
            password STRING NOT NULL
        )
    `).run();

    db.prepare(`
        CREATE TABLE IF NOT EXISTS lists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name STRING NOT NULL,
            userId INTEGER
        )
    `).run();

    db.prepare(`
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name STRING NOT NULL,
            price REAL NOT NULL,
            quantity INTEGER NOT NULL,
            targetQuantity INTEGER NOT NULL,
            listId INTEGER
        )
    `).run();

    db.prepare(`
        CREATE TABLE IF NOT EXISTS products_catalog (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name STRING NOT NULL,
            price REAL NOT NULL
        )
    `).run();

    db.prepare(`
        CREATE TABLE IF NOT EXISTS friend_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fromUserId INTEGER NOT NULL,
            toUserId INTEGER NOT NULL,
            date TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
        )
    `).run();

    db.prepare(`
        CREATE TABLE IF NOT EXISTS shared_lists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            listId INTEGER,
            fromUserId INTEGER,
            toUserId INTEGER
        )
    `).run();

});
createTables();

// --- EXPRESS SETUP ---
const app = express();
app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static("public"));
app.use(cookieParser());

// --- USER AUTH MIDDLEWARE ---
app.use((req, res, next) => {
    console.log("COOKIES:", req.cookies);

    try {
        const token = req.cookies.SuperMarketApp;

        if (!token) throw new Error("No token");

        const decoded = jwt.verify(token, process.env.JWTSECRET);

        console.log("DECODED USER:", decoded);

        req.user = decoded;
    } catch (err) {
        console.log("JWT ERROR:", err.message);
        req.user = false;
    }

    res.locals.user = req.user;
    next();
});

// --- ROUTES ---

// Homepage / Shopping list main page
app.get("/", (req, res) => {
    if (!req.user) return res.render("homepage", { errors: [] });

    const lists = db.prepare("SELECT * FROM lists WHERE userId = ?").all(req.user.userid);
    const listsWithProducts = lists.map(list => {
        const products = db.prepare("SELECT * FROM products WHERE listId = ?").all(list.id);
        return { ...list, products };
    });

    // Pending Friend Requests
    const friendRequests = db.prepare(`
        SELECT fr.id, u.username as fromUsername
        FROM friend_requests fr
        JOIN users u ON u.id = fr.fromUserId
        WHERE fr.toUserId = ? AND fr.status = 'pending'
    `).all(req.user.userid);

    // Friends (accepted requests)
    const friends = db.prepare(`
        SELECT u.username 
        FROM users u
        WHERE u.id IN (
            SELECT CASE 
                     WHEN fr.fromUserId = ? THEN fr.toUserId
                     ELSE fr.fromUserId
                   END
            FROM friend_requests fr
            WHERE fr.status = 'accepted' AND (fr.fromUserId = ? OR fr.toUserId = ?)
        )
    `).all(req.user.userid, req.user.userid, req.user.userid);

    const sharedLists = db.prepare(`
        SELECT l.*, u.username AS owner
        FROM shared_lists sl
        JOIN lists l ON l.id = sl.listId
        JOIN users u ON u.id = sl.fromUserId
        WHERE sl.toUserId = ?
    `).all(req.user.userid);

    const sharedListsWithProducts = sharedLists.map(list => {
        const products = db.prepare("SELECT * FROM products WHERE listId = ?").all(list.id);
        return { ...list, products };
    });

    res.render("shoppinglist", { 
        lists: listsWithProducts, 
        sharedLists: sharedListsWithProducts,
        user: req.user, 
        friendRequests, 
        friends 
    });

});

// --- SEND FRIEND REQUEST ---
app.post("/send-friend-request", (req,res) => {
    if(!req.user) return res.status(401).json({message:"Not logged in"});
    const toUsername = (req.body.username||"").trim();
    const toUser = db.prepare("SELECT * FROM users WHERE username = ?").get(toUsername);
    if(!toUser) return res.status(404).json({message:"User not found"});

    const exists = db.prepare(`
        SELECT * FROM friend_requests 
        WHERE (fromUserId = ? AND toUserId = ?) OR (fromUserId = ? AND toUserId = ?)
    `).get(req.user.userid, toUser.id, toUser.id, req.user.userid);

    if(exists) return res.json({message:"Friend request already exists!"});

    db.prepare("INSERT INTO friend_requests (fromUserId, toUserId, date, status) VALUES (?, ?, ?, 'pending')")
      .run(req.user.userid, toUser.id, new Date().toISOString());

    res.json({message:"Friend request sent!"});
});

// --- ACCEPT FRIEND REQUEST (UPDATED) ---
// --- ACCEPT FRIEND REQUEST ---
app.post("/accept-friend-request", (req, res) => {
    if (!req.user) return res.status(401).json({ message: "Not logged in" });

    const requestId = Number(req.body.requestId); // εξασφαλίζουμε ότι είναι αριθμός
    console.log("Trying to accept friend request with id:", requestId, "for user:", req.user.userid);

    const friendRequest = db.prepare(`
        SELECT * FROM friend_requests
        WHERE id = ? AND toUserId = ? AND status = 'pending'
    `).get(requestId, req.user.userid);

    console.log("Found request:", friendRequest);

    if (!friendRequest) return res.status(404).json({ message: "Friend request not found or already processed" });

    db.prepare("UPDATE friend_requests SET status = 'accepted' WHERE id = ?").run(requestId);
    res.redirect("/");
});

// --- REJECT FRIEND REQUEST ---
app.post("/reject-friend-request", (req, res) => {
    if (!req.user) return res.status(401).json({ message: "Not logged in" });

    const requestId = Number(req.body.requestId); // εξασφαλίζουμε ότι είναι αριθμός
    console.log("Trying to reject friend request with id:", requestId, "for user:", req.user.userid);

    const friendRequest = db.prepare(`
        SELECT * FROM friend_requests
        WHERE id = ? AND toUserId = ? AND status = 'pending'
    `).get(requestId, req.user.userid);

    console.log("Found request:", friendRequest);

    if (!friendRequest) return res.status(404).json({ message: "Friend request not found or already processed" });

    db.prepare("UPDATE friend_requests SET status = 'rejected' WHERE id = ?").run(requestId);
    res.redirect("/");
});

// --- LOGIN / LOGOUT ---
app.get("/login", (req, res) => res.render("loginpage"));
app.get("/logout", (req, res) => {
    res.clearCookie("SuperMarketApp");
    res.redirect("/");
});

app.post("/login", (req, res) => {
    const errors = [];
    if (!req.body.username || !req.body.password) errors.push("Invalid username / password.");
    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(req.body.username);
    if (!user || !bcrypt.compareSync(req.body.password, user.password)) {
        errors.push("Invalid username / password.");
        return res.render("loginpage", { errors });
    }
    const token = jwt.sign(
        { exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24, userid: user.id, username: user.username },
        process.env.JWTSECRET
    );

    res.cookie("SuperMarketApp", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production", // μόνο σε production true
        sameSite: "lax",   // 🔥 αλλαγή εδώ
        maxAge: 1000 * 60 * 60 * 24
    });

    res.redirect("/");
});

// --- REGISTER ---
app.post("/register", (req, res) => {
    const { username, password, confirmPassword } = req.body;

    if (!username || !password || !confirmPassword) {
        return res.render("homepage", { errors: ["Missing fields"] });
    }

    if (password !== confirmPassword) {
        return res.render("homepage", { errors: ["Passwords do not match"] });
    }

    const exists = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
    if (exists) {
        return res.render("homepage", { errors: ["User already exists"] });
    }

    const hashed = bcrypt.hashSync(password, 10);

    const result = db
        .prepare("INSERT INTO users(username, password) VALUES (?, ?)")
        .run(username, hashed);

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);

    const token = jwt.sign(
        { userid: user.id, username: user.username },
        process.env.JWTSECRET,
        { expiresIn: "1d" }
    );

    res.cookie("SuperMarketApp", token, {
        httpOnly: true,
        sameSite: "lax"
    });
    
    return res.redirect("/");
});

// --- CREATE / DELETE LISTS ---
app.get("/create-new-list", (req,res) => res.render("create-list"));

app.post("/create-list", (req,res) => {
    const result = db.prepare("INSERT INTO lists(name, userId) VALUES (?, ?)").run(req.body.listName, req.user.userid);
    res.redirect("/list/" + result.lastInsertRowid);
});

app.post("/delete-list", (req,res) => {
    if(!req.user) return res.redirect("/");
    const listId = req.body.listId;
    db.prepare("DELETE FROM products WHERE listId = ?").run(listId);
    db.prepare("DELETE FROM lists WHERE id = ? AND userId = ?").run(listId, req.user.userid);
    res.redirect("/");
});

app.post("/delete-user", (req,res) => {
    if(!req.user) return res.redirect("/");
    const userId = req.user.userid;
    db.prepare("DELETE FROM products WHERE listId IN (SELECT id FROM lists WHERE userId = ?)").run(userId);
    db.prepare("DELETE FROM lists WHERE userId = ?").run(userId);
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    res.clearCookie("SuperMarketApp");
    res.redirect("/");
});

// --- SEARCH USERS ---
app.get("/search-users", (req,res) => {
    if(!req.user) return res.json([]);
    const q = (req.query.q||"").trim();
    if(!q) return res.json([]);
    const users = db.prepare("SELECT username FROM users WHERE username LIKE ? AND id != ? LIMIT 10").all(`%${q}%`, req.user.userid);
    res.json(users);
});

// --- SEARCH PRODUCTS ---
app.get("/search-products", (req,res) => {
    const q = (req.query.q||"").trim();
    if(!q) return res.json([]);
    const words = q.split(/\s+/);
    const sql = `SELECT * FROM products_catalog WHERE ` + words.map(()=> "name LIKE ? COLLATE NOCASE").join(" OR ") + " LIMIT 10";
    const params = words.map(w => `%${w}%`);
    const results = db.prepare(sql).all(...params);
    res.json(results);
});

app.get("/list/:id", (req, res) => {
    if (!req.user) return res.redirect("/login");

    const listId = Number(req.params.id);

    const list = db.prepare(`
        SELECT * FROM lists 
        WHERE id = ?
        AND (
            userId = ? 
            OR id IN (
                SELECT listId FROM shared_lists WHERE toUserId = ?
            )
        )
    `).get(listId, req.user.userid, req.user.userid);

    if (!list) return res.status(404).send("List not found");

    // ✅ ΦΕΡΝΟΥΜΕ ΤΑ PRODUCTS
    const products = db.prepare(`
        SELECT * FROM products WHERE listId = ?
    `).all(listId);

    res.render("list", { list, products });
});

app.post("/add-product", (req, res) => {
    if (!req.user) return res.status(401).send("Not logged in");

    const { listId, name, price = 0, quantity = 1, targetQuantity = 1 } = req.body;

    if (!listId || !name) return res.status(400).send("Missing required fields");

    // Έλεγχος ότι η λίστα ανήκει στον χρήστη
    const list = db.prepare(`
        SELECT * FROM lists 
        WHERE id = ?
        AND (
            userId = ? 
            OR id IN (
                SELECT listId FROM shared_lists WHERE toUserId = ?
            )
        )
    `).get(listId, req.user.userid, req.user.userid);

    if (!list) return res.status(403).send("No access");

    db.prepare(`
        INSERT INTO products(name, price, quantity, targetQuantity, listId)
        VALUES (?, ?, ?, ?, ?)
    `).run(name, price, quantity, targetQuantity, listId);

    // Αν η φόρμα θέλει redirect
    res.redirect("/list/" + listId);

    // Αν χρησιμοποιείς AJAX / fetch
    // res.json({message: "Product added!"});
});

app.get("/edit-product/:id", (req, res) => {
    if (!req.user) return res.redirect("/login");

    const productId = Number(req.params.id);

    const product = db.prepare(`
        SELECT * FROM products WHERE id = ?
    `).get(productId);

    if (!product) return res.status(404).send("Product not found");

    res.render("edit-product", { product });
});

app.post("/update-product", (req, res) => {
    const { id, name, price, quantity, targetQuantity, listId } = req.body;

    const list = db.prepare(`
        SELECT * FROM lists 
        WHERE id = ?
        AND (
            userId = ? 
            OR id IN (
                SELECT listId FROM shared_lists WHERE toUserId = ?
            )
        )
    `).get(listId, req.user.userid, req.user.userid);

    if (!list) return res.status(403).send("No access");

    db.prepare(`
        UPDATE products
        SET name = ?, price = ?, quantity = ?, targetQuantity = ?
        WHERE id = ?
    `).run(name, price, quantity, targetQuantity, id);

    res.redirect("/list/" + listId);
});

app.post("/delete-product", (req, res) => {
    if (!req.user) return res.redirect("/");

    const { id, listId } = req.body;

    const list = db.prepare(`
        SELECT * FROM lists 
        WHERE id = ?
        AND (
            userId = ? 
            OR id IN (
                SELECT listId FROM shared_lists WHERE toUserId = ?
            )
        )
    `).get(listId, req.user.userid, req.user.userid);

    if (!list) return res.status(403).send("No access");

    db.prepare("DELETE FROM products WHERE id = ?").run(id);

    res.redirect("/list/" + listId);
});

app.get("/send-list", (req, res) => {

    const lists = db.prepare("SELECT * FROM lists WHERE userId=?")
        .all(req.user.userid);

    const friends = db.prepare(`
        SELECT u.id, u.username
        FROM users u
        WHERE u.id IN (
            SELECT CASE 
                WHEN fr.fromUserId = ? THEN fr.toUserId
                ELSE fr.fromUserId
            END
            FROM friend_requests fr
            WHERE fr.status='accepted'
            AND (fr.fromUserId = ? OR fr.toUserId = ?)
        )
    `).all(req.user.userid, req.user.userid, req.user.userid);

    res.render("send-list", { lists, friends });
});

app.post("/send-list", (req, res) => {

    const { listId, friendId } = req.body;

    const exists = db.prepare(`
        SELECT * FROM shared_lists
        WHERE listId=? AND toUserId=?
    `).get(listId, friendId);

    if (exists) return res.send("Already shared");

    db.prepare(`
        INSERT INTO shared_lists(listId,fromUserId,toUserId)
        VALUES (?,?,?)
    `).run(listId, req.user.userid, friendId);

    res.redirect("/");
});

const PORT = process.env.PORT || 3000;
// --- START SERVER ---
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});    
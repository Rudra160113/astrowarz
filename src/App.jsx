import { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, query, limit, addDoc, onSnapshot, doc, getDoc, setDoc } from 'firebase/firestore';
import { nanoid } from 'nanoid';

// Global variables provided by the canvas environment.
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = JSON.parse(typeof __firebase_config !== 'undefined' ? __firebase_config : '{}');
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : '';

const App = () => {
    const canvasRef = useRef(null);
    const [gameState, setGameState] = useState('start'); // 'start', 'playing', 'gameOver'
    const [score, setScore] = useState(0);
    const [lives, setLives] = useState(3);
    const [name, setName] = useState('');
    const [highScores, setHighScores] = useState([]);
    const [personalBest, setPersonalBest] = useState(0);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const gameLoopId = useRef(null);
    const powerupTimerId = useRef(null);

    // --- Firebase Initialization and Auth ---
    useEffect(() => {
        const initFirebase = async () => {
            try {
                if (Object.keys(firebaseConfig).length > 0) {
                    const app = initializeApp(firebaseConfig);
                    const firestore = getFirestore(app);
                    const authInstance = getAuth(app);
                    setDb(firestore);
                    setAuth(authInstance);

                    if (initialAuthToken) {
                        await signInWithCustomToken(authInstance, initialAuthToken);
                    } else {
                        await signInAnonymously(authInstance);
                    }
                }
            } catch (error) {
                console.error("Firebase initialization failed:", error);
            }
        };
        initFirebase();
    }, []);

    useEffect(() => {
        if (auth) {
            const unsubscribe = onAuthStateChanged(auth, (user) => {
                if (user) {
                    setUserId(user.uid);
                } else {
                    setUserId(nanoid()); // Use a temporary ID if no user
                }
                setIsAuthReady(true);
            });
            return () => unsubscribe();
        }
    }, [auth]);

    // --- High Score and Personal Best Leaderboard Listeners ---
    useEffect(() => {
        if (!isAuthReady || !db || !userId) return;

        // Listen for global high scores
        const highScoresCollection = collection(db, `artifacts/${appId}/public/data/highscores`);
        const q = query(highScoresCollection, limit(100)); // Fetch enough to sort locally

        const unsubscribeHighScores = onSnapshot(q, (snapshot) => {
            const scoresData = [];
            snapshot.forEach((doc) => {
                scoresData.push({ id: doc.id, ...doc.data() });
            });
            scoresData.sort((a, b) => b.score - a.score);
            setHighScores(scoresData.slice(0, 10)); // Display top 10
        });

        // Listen for personal best score
        const personalBestDocRef = doc(db, `artifacts/${appId}/users/${userId}/personalHighScores/best`);
        const unsubscribePersonalBest = onSnapshot(personalBestDocRef, (docSnap) => {
            if (docSnap.exists()) {
                setPersonalBest(docSnap.data().score);
            } else {
                setPersonalBest(0);
            }
        });

        return () => {
            unsubscribeHighScores();
            unsubscribePersonalBest();
        };
    }, [isAuthReady, db, userId]);

    // --- Game Logic ---
    useEffect(() => {
        if (gameState !== 'playing') {
            if (gameLoopId.current) cancelAnimationFrame(gameLoopId.current);
            return;
        }

        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');

        // Game state variables
        const SHIP_SIZE = 30;
        const ASTEROID_SPEED_MOD = 1.0;
        const ASTEROID_SPAWN_INTERVAL = 1000;
        const MAX_ASTEROIDS = 10;
        const BULLET_SPEED = 5;
        let lastAsteroidSpawn = 0;
        let lastShotTime = 0;
        let shotCooldown = 250;
        let powerupDuration = 5000;
        let powerupActive = false;
        let powerupEndTime;

        // Game objects
        let ship = {
            x: canvas.width / 2,
            y: canvas.height / 2,
            r: SHIP_SIZE / 2,
            a: Math.PI / 2,
            thrust: { x: 0, y: 0 },
            turn_rate: 0,
            velocity: { x: 0, y: 0 },
            friction: 0.98
        };
        let asteroids = [];
        let bullets = [];
        let powerups = [];

        // --- Tone.js Audio Setup ---
        const laserSynth = new window.Tone.Synth({
            oscillator: { type: "sawtooth" },
            envelope: {
                attack: 0.001,
                decay: 0.1,
                sustain: 0.05,
                release: 0.1
            }
        }).toDestination();

        const explosionSynth = new window.Tone.NoiseSynth({
            envelope: {
                attack: 0.001,
                decay: 0.2,
                sustain: 0,
                release: 0.1
            }
        }).toDestination();

        const gameOverSynth = new window.Tone.Synth({
            oscillator: { type: "square" },
            envelope: {
                attack: 0.01,
                decay: 0.4,
                sustain: 0.1,
                release: 0.5
            }
        }).toDestination();

        const update = () => {
            // Check if power-up has expired
            if (powerupActive && Date.now() > powerupEndTime) {
                powerupActive = false;
                shotCooldown = 250;
                clearTimeout(powerupTimerId.current);
            }

            // Spawn new asteroids
            if (Date.now() - lastAsteroidSpawn > ASTEROID_SPAWN_INTERVAL && asteroids.length < MAX_ASTEROIDS + Math.floor(score / 500)) {
                createAsteroid();
                lastAsteroidSpawn = Date.now();
            }

            // Spawn power-ups occasionally
            if (Math.random() < 0.001 && powerups.length < 1) {
                createPowerUp();
            }

            // Update ship position and velocity
            ship.a += ship.turn_rate;
            ship.velocity.x += Math.cos(ship.a) * ship.thrust.x;
            ship.velocity.y -= Math.sin(ship.a) * ship.thrust.y;
            ship.velocity.x *= ship.friction;
            ship.velocity.y *= ship.friction;
            ship.x += ship.velocity.x;
            ship.y += ship.velocity.y;

            // Wrap ship around the screen
            if (ship.x < 0) ship.x = canvas.width;
            if (ship.x > canvas.width) ship.x = 0;
            if (ship.y < 0) ship.y = canvas.height;
            if (ship.y > canvas.height) ship.y = 0;

            // Update bullets
            for (let i = bullets.length - 1; i >= 0; i--) {
                const bullet = bullets[i];
                bullet.x += bullet.velocity.x;
                bullet.y += bullet.velocity.y;
                if (bullet.x < 0 || bullet.x > canvas.width || bullet.y < 0 || bullet.y > canvas.height) {
                    bullets.splice(i, 1);
                }
            }

            // Update asteroids
            for (let i = asteroids.length - 1; i >= 0; i--) {
                const asteroid = asteroids[i];
                asteroid.x += asteroid.velocity.x;
                asteroid.y += asteroid.velocity.y;
                if (asteroid.x < 0 - asteroid.r) asteroid.x = canvas.width + asteroid.r;
                if (asteroid.x > canvas.width + asteroid.r) asteroid.x = 0 - asteroid.r;
                if (asteroid.y < 0 - asteroid.r) asteroid.y = canvas.height + asteroid.r;
                if (asteroid.y > canvas.height + asteroid.r) asteroid.y = 0 - asteroid.r;

                if (checkCollision(ship, asteroid)) {
                    setLives(l => l - 1);
                    resetShip();
                    asteroids.splice(i, 1);
                }

                for (let j = bullets.length - 1; j >= 0; j--) {
                    const bullet = bullets[j];
                    if (checkCollision(bullet, asteroid)) {
                        bullets.splice(j, 1);
                        breakAsteroid(asteroid, i);
                        setScore(s => s + 10);
                    }
                }
            }

            // Update powerups
            for (let i = powerups.length - 1; i >= 0; i--) {
                const powerup = powerups[i];
                powerup.x += powerup.velocity.x;
                powerup.y += powerup.velocity.y;
                if (checkCollision(ship, powerup)) {
                    activatePowerUp();
                    powerups.splice(i, 1);
                }
            }
        };

        const draw = () => {
            // Clear canvas
            ctx.fillStyle = '#0d0d1a';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Draw asteroids
            asteroids.forEach(drawAsteroid);
            // Draw powerups
            powerups.forEach(drawPowerUp);
            // Draw ship
            drawShip();
            // Draw bullets
            bullets.forEach(drawBullet);
        };

        // --- Drawing Functions ---
        const drawShip = () => {
            ctx.save();
            ctx.translate(ship.x, ship.y);
            ctx.rotate(ship.a);
            ctx.beginPath();
            ctx.moveTo(0, -ship.r);
            ctx.lineTo(-ship.r * 0.75, ship.r);
            ctx.lineTo(ship.r * 0.75, ship.r);
            ctx.closePath();
            ctx.strokeStyle = powerupActive ? '#ff00ff' : '#00ff00';
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.restore();
        };

        const drawAsteroid = (asteroid) => {
            ctx.beginPath();
            ctx.strokeStyle = '#ffff00';
            ctx.lineWidth = 2;
            let angle = 0;
            ctx.moveTo(
                asteroid.x + asteroid.r * Math.cos(angle),
                asteroid.y + asteroid.r * Math.sin(angle)
            );
            for (let i = 1; i < asteroid.sides; i++) {
                angle += (Math.PI * 2) / asteroid.sides;
                ctx.lineTo(
                    asteroid.x + asteroid.r * Math.cos(angle),
                    asteroid.y + asteroid.r * Math.sin(angle)
                );
            }
            ctx.closePath();
            ctx.stroke();
        };

        const drawBullet = (bullet) => {
            ctx.beginPath();
            ctx.arc(bullet.x, bullet.y, bullet.r, 0, Math.PI * 2);
            ctx.fillStyle = '#ff00ff';
            ctx.fill();
        };

        const drawPowerUp = (powerup) => {
            ctx.beginPath();
            ctx.arc(powerup.x, powerup.y, powerup.r, 0, Math.PI * 2);
            ctx.fillStyle = '#ff00ff';
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.save();
            ctx.translate(powerup.x, powerup.y);
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(-powerup.r * 0.5, 0);
            ctx.lineTo(powerup.r * 0.5, 0);
            ctx.moveTo(0, -powerup.r * 0.5);
            ctx.lineTo(0, powerup.r * 0.5);
            ctx.stroke();
            ctx.restore();
        };

        // --- Helper Functions ---
        const createAsteroid = (x, y, r) => {
            let newX, newY;
            if (!x) {
                if (Math.random() > 0.5) {
                    newX = Math.random() < 0.5 ? 0 - (r || 50) : canvas.width + (r || 50);
                    newY = Math.random() * canvas.height;
                } else {
                    newX = Math.random() * canvas.width;
                    newY = Math.random() < 0.5 ? 0 - (r || 50) : canvas.height + (r || 50);
                }
            } else {
                newX = x;
                newY = y;
            }

            asteroids.push({
                x: newX,
                y: newY,
                r: r || 50,
                sides: Math.floor(Math.random() * 5) + 5,
                velocity: {
                    x: (Math.random() - 0.5) * ASTEROID_SPEED_MOD,
                    y: (Math.random() - 0.5) * ASTEROID_SPEED_MOD,
                },
            });
        };

        const createPowerUp = () => {
            powerups.push({
                x: Math.random() * canvas.width,
                y: Math.random() * canvas.height,
                r: 15,
                velocity: {
                    x: (Math.random() - 0.5) * 0.5,
                    y: (Math.random() - 0.5) * 0.5,
                }
            });
        };

        const activatePowerUp = () => {
            powerupActive = true;
            shotCooldown = 100;
            powerupEndTime = Date.now() + powerupDuration;
            powerupTimerId.current = setTimeout(() => {
                powerupActive = false;
                shotCooldown = 250;
            }, powerupDuration);
        };

        const shootBullet = () => {
            const now = Date.now();
            if (now - lastShotTime > shotCooldown) {
                bullets.push({
                    x: ship.x,
                    y: ship.y,
                    r: 3,
                    velocity: {
                        x: Math.cos(ship.a) * BULLET_SPEED,
                        y: -Math.sin(ship.a) * BULLET_SPEED
                    }
                });
                laserSynth.triggerAttackRelease("C5", "16n");
                lastShotTime = now;
            }
        };

        const checkCollision = (obj1, obj2) => {
            const dx = obj1.x - obj2.x;
            const dy = obj1.y - obj2.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            return distance < obj1.r + obj2.r;
        };

        const breakAsteroid = (asteroid, index) => {
            if (asteroid.r > 20) {
                const newSize = asteroid.r / 2;
                createAsteroid(asteroid.x, asteroid.y, newSize);
                createAsteroid(asteroid.x, asteroid.y, newSize);
            }
            explosionSynth.triggerAttackRelease("16n");
            asteroids.splice(index, 1);
        };

        const resetShip = () => {
            ship.x = canvas.width / 2;
            ship.y = canvas.height / 2;
            ship.velocity.x = 0;
            ship.velocity.y = 0;
            ship.a = Math.PI / 2;
        };

        // Input Handlers
        const handleKeyDown = (e) => {
            if (gameState !== 'playing') return;
            switch (e.key) {
                case 'ArrowLeft': case 'a': ship.turn_rate = -0.05; break;
                case 'ArrowRight': case 'd': ship.turn_rate = 0.05; break;
                case 'ArrowUp': case 'w': ship.thrust.y = 0.2; break;
                case 'ArrowDown': case 's': ship.thrust.y = -0.2; break;
                case ' ': shootBullet(); break;
            }
        };
        const handleKeyUp = (e) => {
            if (gameState !== 'playing') return;
            switch (e.key) {
                case 'ArrowLeft': case 'a': case 'ArrowRight': case 'd': ship.turn_rate = 0; break;
                case 'ArrowUp': case 'w': case 'ArrowDown': case 's': ship.thrust.y = 0; break;
            }
        };

        const handleMouseDown = (e) => {
            if (gameState !== 'playing' || window.innerWidth < 768) return;
            // ... (mouse logic) ...
        };

        const handleMouseUp = (e) => {
            if (gameState !== 'playing' || window.innerWidth < 768) return;
            // ... (mouse logic) ...
        };

        const handleMouseMove = (e) => {
            if (gameState !== 'playing' || window.innerWidth < 768) return;
            // ... (mouse logic) ...
        };

        const handleResize = () => {
            if (canvas) {
                canvas.width = Math.min(window.innerWidth - 20, 800);
                canvas.height = Math.min(window.innerHeight - 200, 600);
                ship.x = canvas.width / 2;
                ship.y = canvas.height / 2;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        window.addEventListener('resize', handleResize);
        window.addEventListener('mousedown', handleMouseDown);
        window.addEventListener('mouseup', handleMouseUp);
        window.addEventListener('mousemove', handleMouseMove);
        handleResize();

        if (lives <= 0) {
            setGameState('gameOver');
            gameOverSynth.triggerAttackRelease("C3", "4n");
        } else {
            gameLoopId.current = requestAnimationFrame(gameLoop);
        }

        return () => {
            cancelAnimationFrame(gameLoopId.current);
            clearTimeout(powerupTimerId.current);
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            window.removeEventListener('resize', handleResize);
            window.removeEventListener('mousedown', handleMouseDown);
            window.removeEventListener('mouseup', handleMouseUp);
            window.removeEventListener('mousemove', handleMouseMove);
        };
    }, [gameState, score, lives]);

    // --- High Score Submission ---
    const saveScore = async () => {
        if (!db || !auth || !name.trim()) return;

        const highScoresCollection = collection(db, `artifacts/${appId}/public/data/highscores`);
        const personalBestDocRef = doc(db, `artifacts/${appId}/users/${userId}/personalHighScores/best`);

        try {
            // Save to public high scores
            await addDoc(highScoresCollection, {
                userId: userId,
                name: name,
                score: score,
                timestamp: new Date()
            });

            // Save to personal best if it's a new high score
            if (score > personalBest) {
                await setDoc(personalBestDocRef, { score: score });
            }

            setGameState('leaderboard');
        } catch (error) {
            console.error("Error saving score:", error);
        }
    };

    const renderContent = () => {
        switch (gameState) {
            case 'start':
                return (
                    <div className="flex flex-col items-center">
                        <h1 className="text-5xl font-bold text-yellow-400 mb-8 drop-shadow-neon animate-pulse">ASTEROID SHOOTER</h1>
                        <button
                            className="text-2xl control-button"
                            onClick={() => {
                                setScore(0);
                                setLives(3);
                                setGameState('playing');
                                if (window.Tone && window.Tone.context.state !== 'running') {
                                    window.Tone.start();
                                }
                            }}
                        >
                            START GAME
                        </button>
                    </div>
                );
            case 'playing':
                return (
                    <div className="flex flex-col items-center w-full">
                        <div className="flex justify-between w-full max-w-2xl px-4 mb-4">
                            <h2 className="text-xl text-green-400">SCORE: {score}</h2>
                            <h2 className="text-xl text-red-400">LIVES: {lives}</h2>
                        </div>

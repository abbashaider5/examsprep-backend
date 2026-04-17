import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

import Exam from '../models/Exam.js';
import User from '../models/User.js';

const ADMIN = { name: 'Admin User', email: 'admin@examprep.com', password: 'Admin@123', role: 'admin' };
const USER = { name: 'John Doe', email: 'user@examprep.com', password: 'User@123', role: 'user' };

const SAMPLE_EXAMS = [
  {
    title: 'Cyber Security Fundamentals',
    subject: 'Cyber Security',
    difficulty: 'medium',
    topics: ['CIA Triad', 'SQL Injection', 'XSS', 'Phishing', 'Networking'],
    questions: [
      { question: 'What does the CIA Triad stand for in cybersecurity?', options: ['A. Control, Integrity, Access', 'B. Confidentiality, Integrity, Availability', 'C. Cyber, Internet, Access', 'D. Control, Internet, Authentication'], correctAnswer: 1, explanation: 'The CIA Triad represents the three core principles: Confidentiality (data accessible only to authorized parties), Integrity (data is accurate and unaltered), and Availability (data is accessible when needed).', topic: 'CIA Triad' },
      { question: 'What is SQL Injection?', options: ['A. A database optimization technique', 'B. A cyber attack that manipulates database queries', 'C. A programming language feature', 'D. A type of firewall'], correctAnswer: 1, explanation: 'SQL Injection is an attack where malicious SQL code is inserted into input fields to manipulate database queries, potentially exposing or modifying data.', topic: 'SQL Injection' },
      { question: 'Which HTTP header helps prevent XSS attacks?', options: ['A. Content-Type', 'B. Content-Security-Policy', 'C. Authorization', 'D. Accept-Encoding'], correctAnswer: 1, explanation: 'Content-Security-Policy (CSP) header restricts which scripts can run on a page, significantly reducing XSS attack vectors.', topic: 'XSS' },
      { question: 'What is phishing?', options: ['A. A legitimate marketing email campaign', 'B. A social engineering attack to steal credentials', 'C. A network scanning technique', 'D. A type of encryption'], correctAnswer: 1, explanation: 'Phishing is a social engineering attack where attackers impersonate trusted entities to trick users into revealing sensitive information like passwords.', topic: 'Phishing' },
      { question: 'What port does HTTPS typically use?', options: ['A. 80', 'B. 8080', 'C. 443', 'D. 22'], correctAnswer: 2, explanation: 'HTTPS uses port 443 by default, while HTTP uses port 80. Port 22 is SSH and 8080 is an alternate HTTP port.', topic: 'Networking' },
      { question: 'What is a zero-day vulnerability?', options: ['A. A vulnerability that takes zero hours to fix', 'B. A software flaw unknown to the vendor with no patch available', 'C. A vulnerability discovered on January 1st', 'D. A minor bug with no impact'], correctAnswer: 1, explanation: 'A zero-day vulnerability is a security flaw that is unknown to the software vendor, meaning zero days have passed to create a patch.', topic: 'CIA Triad' },
      { question: 'Which attack intercepts communication between two parties?', options: ['A. DDoS attack', 'B. SQL Injection', 'C. Man-in-the-Middle (MITM)', 'D. Brute force attack'], correctAnswer: 2, explanation: 'A Man-in-the-Middle attack occurs when an attacker secretly intercepts and potentially alters communications between two parties.', topic: 'Networking' },
      { question: 'What does HTTPS provide over HTTP?', options: ['A. Faster data transfer', 'B. Encrypted communication via TLS/SSL', 'C. Larger file support', 'D. Better caching'], correctAnswer: 1, explanation: 'HTTPS encrypts data in transit using TLS (Transport Layer Security), protecting against eavesdropping and MITM attacks.', topic: 'Networking' },
      { question: 'What is the purpose of a firewall?', options: ['A. Speed up network traffic', 'B. Monitor and control incoming/outgoing network traffic', 'C. Encrypt data at rest', 'D. Manage user passwords'], correctAnswer: 1, explanation: 'A firewall monitors and controls network traffic based on security rules, blocking unauthorized access while allowing legitimate traffic.', topic: 'Networking' },
      { question: 'Cross-Site Scripting (XSS) allows an attacker to:', options: ['A. Delete the server database', 'B. Inject malicious scripts into web pages viewed by users', 'C. Gain root server access', 'D. DoS the target website'], correctAnswer: 1, explanation: 'XSS attacks inject malicious client-side scripts into web pages, which then execute in the victim\'s browser, potentially stealing cookies or credentials.', topic: 'XSS' },
      { question: 'What is two-factor authentication (2FA)?', options: ['A. Using two different passwords', 'B. Logging in from two devices', 'C. Verifying identity using two different factors', 'D. Having two administrator accounts'], correctAnswer: 2, explanation: '2FA requires two distinct verification factors (e.g., password + OTP) to authenticate a user, significantly improving security.', topic: 'CIA Triad' },
    ],
  },
  {
    title: 'Web Development Essentials',
    subject: 'Web Development',
    difficulty: 'easy',
    topics: ['HTML', 'CSS', 'JavaScript', 'APIs', 'HTTP'],
    questions: [
      { question: 'What does HTML stand for?', options: ['A. Hyper Text Markup Language', 'B. High Tech Modern Language', 'C. Hyper Transfer Markup Language', 'D. Home Tool Markup Language'], correctAnswer: 0, explanation: 'HTML stands for HyperText Markup Language. It is the standard markup language used to create and structure web pages.', topic: 'HTML' },
      { question: 'Which CSS property controls the text color?', options: ['A. font-color', 'B. text-style', 'C. color', 'D. foreground-color'], correctAnswer: 2, explanation: 'The "color" property in CSS is used to set the text color. "font-color" and "text-style" are not valid CSS properties.', topic: 'CSS' },
      { question: 'What HTTP method is used to retrieve data from a server?', options: ['A. POST', 'B. PUT', 'C. DELETE', 'D. GET'], correctAnswer: 3, explanation: 'GET is used to retrieve data. POST creates data, PUT updates data, and DELETE removes data from the server.', topic: 'HTTP' },
      { question: 'Which JavaScript method adds an element to the end of an array?', options: ['A. append()', 'B. push()', 'C. addLast()', 'D. insert()'], correctAnswer: 1, explanation: 'The push() method adds one or more elements to the end of an array and returns the new array length.', topic: 'JavaScript' },
      { question: 'What does API stand for?', options: ['A. Application Programming Interface', 'B. Automated Program Integration', 'C. Advanced Protocol Interface', 'D. Application Protocol Integration'], correctAnswer: 0, explanation: 'API stands for Application Programming Interface. It defines how different software components should interact with each other.', topic: 'APIs' },
      { question: 'What is the correct HTML element for the largest heading?', options: ['A. <h6>', 'B. <heading>', 'C. <h1>', 'D. <head>'], correctAnswer: 2, explanation: '<h1> defines the most important (largest) heading. HTML headings range from <h1> (largest) to <h6> (smallest).', topic: 'HTML' },
      { question: 'Which CSS property is used for adding space inside an element\'s border?', options: ['A. margin', 'B. border-gap', 'C. spacing', 'D. padding'], correctAnswer: 3, explanation: 'Padding adds space inside an element\'s border. Margin adds space outside the border. These are key box model concepts.', topic: 'CSS' },
      { question: 'What status code indicates a successful HTTP request?', options: ['A. 404', 'B. 500', 'C. 200', 'D. 301'], correctAnswer: 2, explanation: '200 OK means the request was successful. 404 means Not Found, 500 is Internal Server Error, and 301 is Moved Permanently.', topic: 'HTTP' },
      { question: 'What does JSON stand for?', options: ['A. Java Standard Object Notation', 'B. JavaScript Object Notation', 'C. JavaScript Ordered Numbers', 'D. Java Scripted Object Network'], correctAnswer: 1, explanation: 'JSON (JavaScript Object Notation) is a lightweight data interchange format that is easy for humans to read and machines to parse.', topic: 'APIs' },
      { question: 'Which keyword declares a constant in modern JavaScript?', options: ['A. var', 'B. let', 'C. def', 'D. const'], correctAnswer: 3, explanation: '"const" declares a block-scoped constant. "let" is for block-scoped variables. "var" is function-scoped. "def" is used in Python.', topic: 'JavaScript' },
    ],
  },
  {
    title: 'Aptitude & Logical Reasoning',
    subject: 'Aptitude',
    difficulty: 'medium',
    topics: ['Number Series', 'Logical Puzzles', 'Arithmetic', 'Patterns'],
    questions: [
      { question: 'What is the next number in the series: 2, 4, 8, 16, ?', options: ['A. 24', 'B. 32', 'C. 20', 'D. 28'], correctAnswer: 1, explanation: 'Each number is doubled. 16 × 2 = 32. This is a geometric sequence with ratio 2.', topic: 'Number Series' },
      { question: 'If a train travels 60 km in 45 minutes, what is its speed in km/h?', options: ['A. 70 km/h', 'B. 75 km/h', 'C. 80 km/h', 'D. 90 km/h'], correctAnswer: 2, explanation: '45 minutes = 0.75 hours. Speed = Distance/Time = 60/0.75 = 80 km/h.', topic: 'Arithmetic' },
      { question: 'Find the odd one out: 2, 3, 5, 7, 9, 11', options: ['A. 2', 'B. 9', 'C. 11', 'D. 3'], correctAnswer: 1, explanation: '9 is the odd one out because it is not a prime number (9 = 3 × 3). All others (2, 3, 5, 7, 11) are prime numbers.', topic: 'Number Series' },
      { question: 'What comes next: A, C, E, G, ?', options: ['A. H', 'B. I', 'C. J', 'D. K'], correctAnswer: 1, explanation: 'The pattern skips one letter each time. A(skip B)C(skip D)E(skip F)G(skip H)I. So the answer is I.', topic: 'Patterns' },
      { question: 'If 6 workers complete a job in 12 days, how many days for 9 workers?', options: ['A. 6 days', 'B. 8 days', 'C. 10 days', 'D. 18 days'], correctAnswer: 1, explanation: 'Total work = 6 × 12 = 72 man-days. With 9 workers: 72 ÷ 9 = 8 days. More workers = fewer days (inverse proportion).', topic: 'Arithmetic' },
      { question: 'What is 15% of 200?', options: ['A. 25', 'B. 35', 'C. 30', 'D. 20'], correctAnswer: 2, explanation: '15% of 200 = (15/100) × 200 = 15 × 2 = 30', topic: 'Arithmetic' },
      { question: 'Complete the series: 1, 1, 2, 3, 5, 8, ?', options: ['A. 11', 'B. 13', 'C. 12', 'D. 16'], correctAnswer: 1, explanation: 'This is the Fibonacci sequence where each number = sum of the two preceding numbers. 5 + 8 = 13.', topic: 'Number Series' },
      { question: 'A is taller than B, C is shorter than A but taller than B. Who is the shortest?', options: ['A. A', 'B. C', 'C. B', 'D. Cannot determine'], correctAnswer: 2, explanation: 'From the clues: A > C > B. Therefore B is the shortest person among the three.', topic: 'Logical Puzzles' },
      { question: 'If APPLE = 5, BANANA = 6, then CHERRY = ?', options: ['A. 5', 'B. 6', 'C. 7', 'D. 8'], correctAnswer: 1, explanation: 'The code represents the number of letters in the word. APPLE has 5, BANANA has 6, CHERRY has 6 letters.', topic: 'Logical Puzzles' },
      { question: 'Which shape has 8 sides?', options: ['A. Heptagon', 'B. Hexagon', 'C. Nonagon', 'D. Octagon'], correctAnswer: 3, explanation: 'An octagon has 8 sides. Hexagon=6, Heptagon=7, Nonagon=9 sides.', topic: 'Patterns' },
    ],
  },
  {
    title: 'Cloud & DevOps Basics',
    subject: 'DevOps',
    difficulty: 'hard',
    topics: ['AWS', 'Docker', 'CI/CD', 'Kubernetes'],
    questions: [
      { question: 'What does S3 stand for in AWS?', options: ['A. Simple Storage Solution', 'B. Simple Storage Service', 'C. Secure Storage Service', 'D. Standard Storage System'], correctAnswer: 1, explanation: 'S3 stands for Simple Storage Service — a scalable object storage service provided by AWS for storing and retrieving data.', topic: 'AWS' },
      { question: 'What is a Docker container?', options: ['A. A virtual machine', 'B. A lightweight, standalone executable package of software', 'C. A cloud database service', 'D. An AWS server type'], correctAnswer: 1, explanation: 'Docker containers are lightweight, standalone packages that include everything needed to run an application (code, runtime, libraries). Unlike VMs, containers share the host OS kernel.', topic: 'Docker' },
      { question: 'What does CI/CD stand for?', options: ['A. Continuous Integration / Continuous Delivery', 'B. Code Inspection / Code Deployment', 'C. Continuous Infrastructure / Continuous Design', 'D. Central Integration / Code Delivery'], correctAnswer: 0, explanation: 'CI/CD stands for Continuous Integration (automatically building/testing code) and Continuous Delivery (automatically deploying tested code to production).', topic: 'CI/CD' },
      { question: 'Which AWS service is used to run containerized applications?', options: ['A. AWS Lambda', 'B. AWS ECS (Elastic Container Service)', 'C. AWS S3', 'D. AWS CloudFront'], correctAnswer: 1, explanation: 'Amazon ECS is a fully managed container orchestration service. AWS Lambda is for serverless functions, S3 for storage, CloudFront for CDN.', topic: 'AWS' },
      { question: 'What is Kubernetes used for?', options: ['A. Code version control', 'B. Container orchestration and management', 'C. Database replication', 'D. Network monitoring'], correctAnswer: 1, explanation: 'Kubernetes (K8s) is an open-source container orchestration platform for automating deployment, scaling, and management of containerized applications.', topic: 'Kubernetes' },
      { question: 'Which Dockerfile instruction sets the base image?', options: ['A. IMAGE', 'B. BASE', 'C. FROM', 'D. SET'], correctAnswer: 2, explanation: 'The FROM instruction in a Dockerfile specifies the base image to build upon. For example: FROM node:18-alpine', topic: 'Docker' },
      { question: 'What is the purpose of AWS IAM?', options: ['A. Image and Media management', 'B. Identity and Access Management for AWS resources', 'C. Internet Access Management', 'D. Instance Auto-Monitoring'], correctAnswer: 1, explanation: 'AWS IAM (Identity and Access Management) controls who can authenticate and what actions they can perform on AWS resources through policies.', topic: 'AWS' },
      { question: 'What does Infrastructure as Code (IaC) mean?', options: ['A. Writing code for app infrastructure', 'B. Managing infrastructure through machine-readable config files', 'C. Using code to test infrastructure', 'D. A type of CI/CD pipeline'], correctAnswer: 1, explanation: 'IaC means managing and provisioning infrastructure through code/config files (like Terraform, CloudFormation) rather than manual processes.', topic: 'CI/CD' },
      { question: 'What is the default command to build a Docker image?', options: ['A. docker run', 'B. docker start', 'C. docker build', 'D. docker create'], correctAnswer: 2, explanation: '"docker build" creates a Docker image from a Dockerfile. "docker run" creates and starts a container from an image.', topic: 'Docker' },
      { question: 'In Kubernetes, what is a Pod?', options: ['A. A cluster of servers', 'B. The smallest deployable unit containing one or more containers', 'C. A type of service discovery', 'D. A load balancer configuration'], correctAnswer: 1, explanation: 'A Pod is the smallest deployable unit in Kubernetes. It can contain one or more containers that share network/storage resources.', topic: 'Kubernetes' },
    ],
  },
  {
    title: 'Data Structures & Algorithms',
    subject: 'Programming',
    difficulty: 'hard',
    topics: ['Arrays', 'Strings', 'Complexity', 'Sorting', 'Data Structures'],
    questions: [
      { question: 'What is the time complexity of binary search?', options: ['A. O(n)', 'B. O(n²)', 'C. O(log n)', 'D. O(1)'], correctAnswer: 2, explanation: 'Binary search has O(log n) time complexity because it halves the search space with each comparison, operating on a sorted array.', topic: 'Complexity' },
      { question: 'Which data structure uses LIFO (Last In, First Out)?', options: ['A. Queue', 'B. Stack', 'C. Linked List', 'D. Tree'], correctAnswer: 1, explanation: 'A Stack follows LIFO — the last element added is the first removed. Think of a stack of plates. Queues use FIFO.', topic: 'Data Structures' },
      { question: 'What is the worst-case time complexity of bubble sort?', options: ['A. O(n log n)', 'B. O(n)', 'C. O(log n)', 'D. O(n²)'], correctAnswer: 3, explanation: 'Bubble sort has O(n²) worst-case complexity as it requires nested iterations over the array to sort elements via adjacent swaps.', topic: 'Sorting' },
      { question: 'How do you reverse a string in Python?', options: ['A. string.reverse()', 'B. reverse(string)', 'C. string[::-1]', 'D. string.reversed()'], correctAnswer: 2, explanation: '"string[::-1]" uses Python slice notation with step -1 to reverse a string. This is the pythonic and most common approach.', topic: 'Strings' },
      { question: 'What is the time complexity of accessing an element in an array by index?', options: ['A. O(n)', 'B. O(log n)', 'C. O(n log n)', 'D. O(1)'], correctAnswer: 3, explanation: 'Array index access is O(1) (constant time) because arrays store elements in contiguous memory, enabling direct calculation of any element\'s address.', topic: 'Arrays' },
      { question: 'Which sorting algorithm is best suited for nearly sorted data?', options: ['A. Merge Sort', 'B. Quick Sort', 'C. Insertion Sort', 'D. Selection Sort'], correctAnswer: 2, explanation: 'Insertion Sort is O(n) for nearly-sorted data, making it excellent for this scenario. It works by inserting each element into its correct position.', topic: 'Sorting' },
      { question: 'What data structure would you use to implement a browser\'s back button?', options: ['A. Queue', 'B. Stack', 'C. Hash Map', 'D. Binary Tree'], correctAnswer: 1, explanation: 'A Stack is ideal for browser back button functionality. Each visited page is pushed onto the stack, and "back" pops the stack to return to the previous page.', topic: 'Data Structures' },
      { question: 'What is a hash collision?', options: ['A. When a hash function crashes', 'B. When two different keys produce the same hash value', 'C. When a hash table is full', 'D. When hashing is too slow'], correctAnswer: 1, explanation: 'A collision occurs when two different keys produce the same hash value. Solutions include chaining (linked lists) or open addressing.', topic: 'Data Structures' },
      { question: 'What is the space complexity of recursive fibonacci?', options: ['A. O(1)', 'B. O(n)', 'C. O(n²)', 'D. O(log n)'], correctAnswer: 1, explanation: 'Naive recursive fibonacci has O(n) space complexity due to the recursion call stack depth. The time complexity is exponential O(2^n).', topic: 'Complexity' },
      { question: 'Which traversal visits nodes: Left → Root → Right?', options: ['A. Pre-order', 'B. Post-order', 'C. Level-order', 'D. In-order'], correctAnswer: 3, explanation: 'In-order traversal visits Left → Root → Right. For a BST, in-order traversal produces sorted output. Pre-order: Root→L→R, Post-order: L→R→Root.', topic: 'Data Structures' },
    ],
  },
];

async function seed() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    await User.deleteOne({ email: ADMIN.email });
    await User.deleteOne({ email: USER.email });

    const admin = await User.create(ADMIN);
    const user = await User.create({ ...USER, xp: 350, totalExams: 3, streak: 2 });
    console.log(`✓ Created admin: ${ADMIN.email}`);
    console.log(`✓ Created user: ${USER.email}`);

    const existingTitles = SAMPLE_EXAMS.map(e => e.title);
    await Exam.deleteMany({ title: { $in: existingTitles } });

    for (const examData of SAMPLE_EXAMS) {
      await Exam.create({ ...examData, createdBy: admin._id, isPublic: true });
      console.log(`✓ Created exam: ${examData.title}`);
    }

    console.log('\n✅ Seed complete!');
    console.log('\nTest credentials:');
    console.log(`  Admin → ${ADMIN.email} / ${ADMIN.password}`);
    console.log(`  User  → ${USER.email} / ${USER.password}`);
    process.exit(0);
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exit(1);
  }
}

seed();

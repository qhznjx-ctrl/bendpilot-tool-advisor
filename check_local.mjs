// Check if we can access the page via HTTP
const res = await fetch('http://localhost:3000/');
const html = await res.text();
console.log('Status:', res.status);
console.log('Length:', html.length);
console.log(html.substring(0, 200));

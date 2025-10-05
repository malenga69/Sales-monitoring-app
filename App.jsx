import React, { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { Line } from 'react-chartjs-2'
import { Chart, registerables } from 'chart.js'
Chart.register(...registerables)

export default function App(){
  const [user, setUser] = useState(null)
  const [sales, setSales] = useState([])
  const [summary, setSummary] = useState(null)
  const fileRef = useRef()

  useEffect(()=>{ fetchSummary(); }, [])

  async function fetchSummary(){
    try {
      const res = await axios.get('/api/reports/summary', { withCredentials: true })
      setSummary(res.data)
    } catch(e){ console.log(e) }
  }

  async function uploadSale(ev){
    ev.preventDefault()
    const form = new FormData(ev.target)
    try {
      await axios.post('/api/sales', form, { withCredentials: true, headers: {'Content-Type':'multipart/form-data'} })
      alert('Saved')
      fetchSummary()
    } catch(e){ alert('Error: ' + e.response?.data?.error || e.message) }
  }

  return (<div className='p-4 max-w-4xl mx-auto'>
    <h1 className='text-2xl font-bold mb-4'>Sales Tracker — PWA-ready</h1>
    <form onSubmit={uploadSale} className='space-y-2'>
      <input name='amount' placeholder='Amount' className='border p-2 w-full' />
      <input name='quantity' placeholder='Quantity' className='border p-2 w-full' />
      <input name='gps_lat' placeholder='GPS lat (optional)' className='border p-2 w-full' />
      <input name='gps_lng' placeholder='GPS lng (optional)' className='border p-2 w-full' />
      <input type='file' name='photo' ref={fileRef} />
      <button className='bg-blue-600 text-white px-4 py-2 rounded'>Save Sale (with photo)</button>
    </form>

    <div className='mt-6'>
      <h2 className='text-xl font-semibold'>Dashboard</h2>
      {summary ? <>
        <p>Total: {summary.total}</p>
        <h3>By user</h3>
        <ul>{summary.byUser.map(u=> <li key={u.id}>{u.username}: {u.total}</li>)}</ul>
      </> : <p>Loading...</p>}
    </div>

    <div className='mt-6'>
      <h2 className='text-xl'>Sales Trend</h2>
      <Line data={{
        labels: ['Jan','Feb','Mar','Apr','May'],
        datasets: [{ label: 'Demo', data: [12,19,3,5,2] }]
      }} />
    </div>
  </div>)
}

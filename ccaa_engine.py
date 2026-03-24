import os
import json
import sys
import mysql.connector

def run_ccaa_algorithm(event_id, reqs_json):
    # ⚡ Read the Cloud Database credentials from Render's environment
    db_host = os.environ.get('DB_HOST', 'localhost')
    db_user = os.environ.get('DB_USER', 'root')
    db_pass = os.environ.get('DB_PASSWORD', 'deploydesk')
    db_name = os.environ.get('DB_NAME', 'deploydesk_db')
    db_port = int(os.environ.get('DB_PORT', 4000))

    db = None
    try:
        # Connect to TiDB Cloud securely
        db = mysql.connector.connect(
            host=db_host,
            user=db_user,
            password=db_pass,
            database=db_name,
            port=db_port,
            ssl_disabled=False
        )
        cursor = db.cursor(dictionary=True)
        
        # 2. Fetch Event Details (⚡ No duration_hours needed)
        cursor.execute("SELECT event_date, start_time, title, status FROM event_requests WHERE id = %s", (event_id,))
        event = cursor.fetchone()
        
        if not event:
            return

        event_date = event['event_date'] 
        ui_day = event_date.weekday()    
        start_hour = int(event['start_time'].seconds // 3600) 
        duration = 1
        event_hours = list(range(start_hour, start_hour + duration))

        personnel_reqs = json.loads(reqs_json)

        for req in personnel_reqs:
            role_str = f"{req['group']} - {req['role']}"
            cursor.execute("SELECT id FROM users WHERE role IN ('member', 'administrative') AND position = %s", (role_str,))
            users = cursor.fetchall()
            
            for u in users:
                uid = u['id']
                
                format_strings = ','.join(['%s'] * len(event_hours))
                query = f"SELECT id FROM user_schedules WHERE user_id=%s AND day_of_week=%s AND hour_of_day IN ({format_strings})"
                params = [uid, ui_day] + event_hours
                cursor.execute(query, tuple(params))
                schedule_conflicts = cursor.fetchall()
                
                if len(schedule_conflicts) == 0:
                    cursor.execute("""
                        SELECT a.id FROM event_allocations a 
                        JOIN event_requests e ON a.event_id = e.id 
                        WHERE a.user_id = %s AND a.status IN ('assigned', 'rostered') 
                        AND e.status IN ('approved', 'pending_admin') AND e.event_date = %s
                    """, (uid, event_date))
                    overlaps = cursor.fetchall()
                    
                    if len(overlaps) == 0:
                        # ⚡ SILENT QUEUE: If awaiting admin, label them 'eligible' but don't notify yet!
                        alloc_status = 'eligible' if event['status'] == 'awaiting_initial_admin' else 'notified'
                        
                        cursor.execute("""
                            INSERT INTO event_allocations (event_id, user_id, required_role, status) 
                            VALUES (%s, %s, %s, %s)
                        """, (event_id, uid, role_str, alloc_status))
                        
                        # Only notify instantly if the admin has already approved the request
                        if alloc_status == 'notified':
                            msg = f"⚡ CCAA Alert: You match the required schedule for '{event['title']}'. Check dashboard!"
                            cursor.execute("INSERT INTO notifications (user_id, message, type, event_id) VALUES (%s, %s, 'info', %s)", 
                                           (uid, msg, event_id))

        db.commit() 
        print(f"CCAA Engine successfully queued candidates for Event {event_id}!")

    except Exception as e:
        print(f"Python CCAA Error: {e}")
    finally:
        if db and db.is_connected():
            cursor.close()
            db.close()

if __name__ == "__main__":
    if len(sys.argv) > 2:
        passed_event_id = int(sys.argv[1])
        passed_reqs = sys.argv[2]
        run_ccaa_algorithm(passed_event_id, passed_reqs)
    else:
        print("Missing arguments for CCAA Engine.")